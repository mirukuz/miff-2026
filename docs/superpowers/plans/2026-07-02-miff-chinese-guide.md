# MIFF 2026 中文导览网站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抓取 MIFF 2026 节目单，补充 IMDB/豆瓣评分，用 Claude 生成中文翻译和一句话看点，输出一个按评分排序的纯静态中文导览单页。

**Architecture:** 四个独立 Node.js 脚本组成流水线（scrape → imdb → douban → translate），每步产出 `data/` 下的中间 JSON，最终合并为 `site/films.json`；前端是零框架静态单页，客户端 fetch films.json 渲染卡片流。7月9日全量节目单发布后重跑 `npm run build` 即可，翻译按 slug+内容哈希缓存。

**Tech Stack:** Node.js ≥ 20（原生 fetch / node:test）、cheerio（唯一运行时依赖，HTML 解析）、`claude -p` CLI（翻译）、纯 HTML/CSS/JS 前端。

## Global Constraints

- 抓 MIFF 限速 ≥ 1.1s/请求；抓豆瓣限速 ≥ 3s/请求 + 随机抖动；UA 统一为 `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`
- 单片失败不中断流水线；失败汇总写 `data/errors.json`
- 抓取后完整性校验：`title_en` 或 `synopsis_en` 缺失率 > 20% 时进程以非零码退出，不产出坏数据
- 豆瓣匹配不到/被反爬 = 正常降级（只留搜索链接），不算错误
- 所有面向用户的文案是简体中文；数据字段名用设计文档定义的英文名
- 测试框架：`node --test`（node:test），不引入 jest/vitest
- `data/cache/`、`node_modules/`、`data/translations/` 之外的中间产物均可再生；`data/translations/` 要提交进 git（翻译成本高）
- 信息行字段（导演/年份/时长/国家）**按文本模式识别，不按位置**（官网字段可选、顺序不完全固定）

## File Structure

```
package.json                  # scripts + cheerio 依赖
.gitignore
scripts/
  lib/fetch.mjs               # 限速 fetch + 重试（scrape/douban 共用）
  lib/parse-miff.mjs          # 纯函数：HTML → 结构化数据（可单测）
  scrape-miff.mjs             # 步骤1：产出 data/miff-raw.json
  lib/imdb-match.mjs          # 纯函数：标题归一化 + 候选挑选（可单测）
  enrich-imdb.mjs             # 步骤2：产出 data/enriched-imdb.json
  lib/douban-match.mjs        # 纯函数：suggest 结果挑选 + 评分页解析（可单测）
  enrich-douban.mjs           # 步骤3：产出 data/enriched-douban.json
  translate.mjs               # 步骤4：claude -p + 缓存，产出 site/films.json
  build.mjs                   # 串联全部，支持 --step=
tests/
  fixtures/                   # 真实抓取的 HTML 样本（提交进 git）
  parse-miff.test.mjs
  imdb-match.test.mjs
  douban-match.test.mjs
site/
  index.html
  app.js
  style.css
  films.json                  # 流水线产物（提交进 git，部署即数据）
data/                         # 中间产物（除 translations 外不提交）
```

---

### Task 1: 项目脚手架 + MIFF 页面解析纯函数

**Files:**
- Create: `package.json`, `.gitignore`, `scripts/lib/fetch.mjs`, `scripts/lib/parse-miff.mjs`
- Test: `tests/parse-miff.test.mjs`, `tests/fixtures/program.html`, `tests/fixtures/film-dead-mans-wire.html`

**Interfaces:**
- Produces: `parseProgramPage(html) -> [{slug, genre, thumb, blurb, director, year, runtime, countries, languages}]`
- Produces: `parseFilmPage(html, slug) -> {slug, title_en, director, year, runtime, countries, premiere, synopsis_en, press_quote, credits, poster, item_hash}`
- Produces: `politeFetch(url, {minDelayMs}) -> Promise<string>`（限速 + 3 次重试，共用一个模块级时间闸）

- [ ] **Step 1: 初始化项目**

```bash
cd /Users/zxc/Documents/projects/active/miff-2026
npm init -y
npm install cheerio
```

把 `package.json` 改为：

```json
{
  "name": "miff-2026-guide",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --test tests/"
  },
  "dependencies": {
    "cheerio": "^1.0.0"
  }
}
```

创建 `.gitignore`：

```
node_modules/
data/*
!data/translations/
data/translations/.tmp*
.DS_Store
```

- [ ] **Step 2: 抓真实页面做测试 fixture**

```bash
mkdir -p tests/fixtures
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" \
  https://miff.com.au/program -o tests/fixtures/program.html
sleep 2
curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" \
  https://miff.com.au/program/film/dead-mans-wire -o tests/fixtures/film-dead-mans-wire.html
```

验证：`grep -c 'film-card' tests/fixtures/program.html` 应 ≥ 20；`grep -c 'film_title' tests/fixtures/film-dead-mans-wire.html` 应 ≥ 1。若 dead-mans-wire 已下线（7月9日后可能），从 program.html 里任选一个现存 slug 替代，并同步修改测试断言中的具体片名/导演。

- [ ] **Step 3: 写失败测试**

`tests/parse-miff.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProgramPage, parseFilmPage } from '../scripts/lib/parse-miff.mjs';

const programHtml = readFileSync(new URL('./fixtures/program.html', import.meta.url), 'utf8');
const filmHtml = readFileSync(new URL('./fixtures/film-dead-mans-wire.html', import.meta.url), 'utf8');

test('parseProgramPage 提取全部影片卡片', () => {
  const films = parseProgramPage(programHtml);
  assert.ok(films.length >= 20, `期望 >=20 部，实际 ${films.length}`);
  for (const f of films) {
    assert.match(f.slug, /^[a-z0-9-]+$/, `slug 非法: ${f.slug}`);
    assert.ok(!f.slug.includes('#'), 'slug 不应包含 #top');
  }
});

test('parseProgramPage 卡片字段按模式解析', () => {
  const films = parseProgramPage(programHtml);
  const withYear = films.filter(f => f.year >= 1900 && f.year <= 2030);
  assert.ok(withYear.length / films.length > 0.8, '大多数卡片应解析出年份');
  const withRuntime = films.filter(f => Number.isInteger(f.runtime) && f.runtime > 0);
  assert.ok(withRuntime.length / films.length > 0.8, '大多数卡片应解析出时长');
  const withDirector = films.filter(f => f.director);
  assert.ok(withDirector.length / films.length > 0.8, '大多数卡片应解析出导演');
});

test('parseFilmPage 解析详情页', () => {
  const film = parseFilmPage(filmHtml, 'dead-mans-wire');
  assert.equal(film.title_en, 'Dead Man’s Wire');
  assert.match(film.director, /Gus Van Sant/);        // 双空格已归一
  assert.equal(film.year, 2025);
  assert.equal(film.runtime, 104);
  assert.deepEqual(film.countries, ['USA']);
  assert.match(film.premiere ?? '', /Premiere/i);
  assert.ok(film.synopsis_en.length > 200, '简介应为多段正文');
  assert.match(film.press_quote ?? '', /^[“"]/, '末尾媒体评语应单独抽出');
  assert.ok(!film.synopsis_en.includes('Hollywood Reporter'), '媒体评语段不应混入简介');
  assert.ok(Array.isArray(film.credits.Director));
  assert.match(film.poster, /^https:\/\/miff\.com\.au\/storage\//);
  assert.equal(film.item_hash, null);                 // 开票前为空
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/lib/parse-miff.mjs`

- [ ] **Step 5: 实现 `scripts/lib/parse-miff.mjs`**

```js
import * as cheerio from 'cheerio';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// 信息行：span 之间以裸文本 "/" 分隔；字段可选、按模式识别。
// 返回 { director, year, runtime, countries, languages, premiere }
export function parseInfoLine($, container) {
  const segments = [];
  let current = [];
  container.contents().each((_, node) => {
    if (node.type === 'text') {
      if (node.data.includes('/')) {
        if (current.length) segments.push(current);
        current = [];
      }
    } else if (node.name === 'span') {
      const t = clean($(node).text());
      if (t) current.push(t);
    }
  });
  if (current.length) segments.push(current);

  const out = { director: null, year: null, runtime: null, countries: [], languages: [], premiere: null };
  const leftovers = [];
  for (const seg of segments) {
    const joined = seg.join(', ');
    if (/^Dir\./i.test(joined)) out.director = clean(joined.replace(/^Dir\.\s*/i, ''));
    else if (seg.length === 1 && /^\d{4}$/.test(seg[0])) out.year = Number(seg[0]);
    else if (seg.length === 1 && /^(\d+)\s*mins?$/i.test(seg[0])) out.runtime = Number(seg[0].match(/^(\d+)/)[1]);
    else if (/premiere/i.test(joined)) out.premiere = joined;
    else leftovers.push(seg);
  }
  // 剩余段按出现顺序：第一段是国家，第二段（列表页才有）是语言
  if (leftovers[0]) out.countries = leftovers[0];
  if (leftovers[1]) out.languages = leftovers[1];
  return out;
}

export function parseProgramPage(html) {
  const $ = cheerio.load(html);
  const films = [];
  $('div.film-card').each((_, el) => {
    const card = $(el);
    const href = card.find('h3 a').attr('href') ?? '';
    const m = href.match(/\/program\/film\/([^#?]+)/);
    if (!m) return;
    const info = parseInfoLine($, card.find('div.leading-tight').first());
    films.push({
      slug: m[1],
      genre: clean(card.find('span.tag').first().text()) || null,
      thumb: card.find('img').attr('src') || null,
      blurb: clean(card.find('div.line-clamp-4').text()) || null,
      director: info.director,
      year: info.year,
      runtime: info.runtime,
      countries: info.countries,
      languages: info.languages,
    });
  });
  return films;
}

export function parseFilmPage(html, slug) {
  const $ = cheerio.load(html);
  const info = parseInfoLine($, $('#film_details div.leading-tight').first());

  // 简介限定在 #film_details 内第一个 .prose（页首活动文案也有 .prose，不能全局选）
  const paragraphs = [];
  $('#film_details .prose').first().find('p').each((_, p) => {
    const t = clean($(p).text());
    if (t) paragraphs.push(t);
  });
  // 媒体评语：只把末尾连续的、以引号开头的段落摘出（简介正文中间合法地可含引号，不能误删）
  const quotes = [];
  while (paragraphs.length && /^[“"]/.test(paragraphs[paragraphs.length - 1])) {
    quotes.unshift(paragraphs.pop());
  }
  const pressQuote = quotes.length ? quotes.join('\n\n') : null;

  const credits = {};
  $('#film_details .creditblock h4.credit-heading').each((_, h) => {
    const role = clean($(h).text());
    const names = $(h).next('div').find('span')
      .map((_, s) => clean($(s).text())).get().filter(Boolean);
    if (role && names.length) credits[role] = names;
  });

  const hashMatch = html.match(/itemHash=([a-f0-9]+)/);
  return {
    slug,
    title_en: clean($('#film_title h1').first().text()) || null,
    director: info.director ?? (credits.Director ? credits.Director.join(', ') : null),
    year: info.year,
    runtime: info.runtime,
    countries: info.countries,
    premiere: info.premiere,
    synopsis_en: paragraphs.join('\n\n') || null,
    press_quote: pressQuote,
    credits,
    poster: $('meta[property="og:image"]').attr('content') || null,
    item_hash: hashMatch ? hashMatch[1] : null,
  };
}
```

- [ ] **Step 6: 实现 `scripts/lib/fetch.mjs`**

```js
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const lastHit = new Map(); // 按 host 限速

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// blockedUrlPattern: 命中最终 URL（跟随重定向后）即判定为被反爬（豆瓣限流是 302 到
// sec.douban.com 验证码页并返回 200，不是 403，必须按最终 URL 识别）
export async function politeFetch(url, { minDelayMs = 1100, retries = 3, headers = {}, blockedUrlPattern = null } = {}) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
      if (res.status === 403 || res.status === 429 || (blockedUrlPattern && blockedUrlPattern.test(res.url))) {
        const err = new Error(`blocked (HTTP ${res.status}, final URL ${res.url}) for ${url}`);
        err.blocked = true;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (e.blocked || attempt >= retries) throw e;
      await sleep(2000 * attempt);
    }
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test`
Expected: PASS（3 个测试）。若某断言因 fixture 变化失败，核对 fixture 实际内容修正断言（不是改解析器迁就错误数据）。

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore scripts/ tests/
git commit -m "feat: MIFF 页面解析纯函数 + 限速 fetch"
```

---

### Task 2: 抓取脚本 scrape-miff.mjs（含完整性校验）

**Files:**
- Create: `scripts/scrape-miff.mjs`
- Test: 复用 Task 1 测试；本任务以真实运行验证

**Interfaces:**
- Consumes: `parseProgramPage` / `parseFilmPage` / `politeFetch`（Task 1）
- Produces: `data/miff-raw.json` — `{ scraped_at, films: [<parseFilmPage 结果 + 列表页的 genre/languages/blurb/thumb>] }`；`data/errors.json`

- [ ] **Step 1: 实现 `scripts/scrape-miff.mjs`**

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { politeFetch } from './lib/fetch.mjs';
import { parseProgramPage, parseFilmPage } from './lib/parse-miff.mjs';

const BASE = 'https://miff.com.au';

// 7月9日全量上线后列表页可能改为 Livewire 分页/懒加载：那种情况下 parseProgramPage
// 只能看到首屏卡片，流水线会"成功"跑出残缺站点。这里做三重截断检测，命中即硬失败。
function assertNotTruncated(listHtml, cards) {
  if (cards.length === 0) throw new Error('列表页解析出 0 部影片 —— 官网结构可能已改版');
  const pagination = listHtml.match(/load[\s-]?more|nextPage|x-intersect|wire:click="[^"]*page/i);
  if (pagination) {
    throw new Error(`列表页出现分页/懒加载标记（${pagination[0]}），当前抓法只能拿到首屏 ${cards.length} 部 —— 需要适配枚举逻辑（见 README）`);
  }
  const totalMatch = listHtml.match(/(\d+)\s+(films|results|titles)/i);
  if (totalMatch && Number(totalMatch[1]) > cards.length * 1.2) {
    throw new Error(`页面声称共 ${totalMatch[1]} 部但只解析出 ${cards.length} 部 —— 列表被截断`);
  }
  if (existsSync('data/miff-raw.json')) {
    const prev = JSON.parse(readFileSync('data/miff-raw.json', 'utf8')).films.length;
    if (cards.length < prev * 0.5) {
      throw new Error(`影片数从上次的 ${prev} 骤降到 ${cards.length} —— 疑似列表截断，如确认官网真的缩减了片单，删除 data/miff-raw.json 后重跑`);
    }
  }
}

export async function scrape() {
  mkdirSync('data', { recursive: true });
  const listHtml = await politeFetch(`${BASE}/program`);
  const cards = parseProgramPage(listHtml);
  assertNotTruncated(listHtml, cards);
  console.log(`列表页发现 ${cards.length} 部影片`);

  const films = [];
  const errors = [];
  for (const [i, card] of cards.entries()) {
    const url = `${BASE}/program/film/${card.slug}`;
    try {
      const html = await politeFetch(url);
      const detail = parseFilmPage(html, card.slug);
      films.push({
        ...detail,
        genre: card.genre,
        languages: card.languages,
        blurb: card.blurb,
        thumb: card.thumb ? new URL(card.thumb, BASE).href : null,
        miff_url: url,
        // 详情页信息行偶有缺字段，用列表页兜底
        year: detail.year ?? card.year,
        runtime: detail.runtime ?? card.runtime,
        countries: detail.countries.length ? detail.countries : card.countries,
      });
      process.stdout.write(`\r[${i + 1}/${cards.length}] ${card.slug}          `);
    } catch (e) {
      errors.push({ slug: card.slug, url, error: String(e) });
    }
  }
  console.log();

  // 完整性校验：防官网改版后静默产出坏数据
  const bad = films.filter((f) => !f.title_en || !f.synopsis_en).length + errors.length;
  const ratio = bad / cards.length;
  writeFileSync('data/errors.json', JSON.stringify(errors, null, 2));
  if (ratio > 0.2) {
    console.error(`完整性校验失败：${bad}/${cards.length} 部影片缺标题或简介（>${20}%）。检查 data/errors.json 与解析器选择器。`);
    process.exit(1);
  }
  writeFileSync('data/miff-raw.json', JSON.stringify({ scraped_at: new Date().toISOString(), films }, null, 2));
  console.log(`完成：${films.length} 部影片写入 data/miff-raw.json；${errors.length} 个错误见 data/errors.json`);
}

if (process.argv[1].endsWith('scrape-miff.mjs')) await scrape();
```

- [ ] **Step 2: 真实运行验证**

Run: `node scripts/scrape-miff.mjs`（约 30–60 秒）
Expected: 输出"列表页发现 27 部影片"（7月9日后为数百部）、无致命错误、生成 `data/miff-raw.json`。

- [ ] **Step 3: 抽查产物**

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('data/miff-raw.json'));console.log(d.films.length, '部');const f=d.films[0];console.log(JSON.stringify(f,null,2).slice(0,800));console.log('缺标题:',d.films.filter(x=>!x.title_en).length,'缺简介:',d.films.filter(x=>!x.synopsis_en).length)"
```

Expected: 缺标题/缺简介均为 0 或个位数；字段与设计文档数据模型一致。

- [ ] **Step 4: Commit**

```bash
git add scripts/scrape-miff.mjs
git commit -m "feat: MIFF 抓取脚本（限速、错误汇总、完整性校验）"
```

---

### Task 3: IMDB 匹配（官方数据集）

**Files:**
- Create: `scripts/lib/imdb-match.mjs`, `scripts/enrich-imdb.mjs`
- Test: `tests/imdb-match.test.mjs`

**Interfaces:**
- Consumes: `data/miff-raw.json`（Task 2）
- Produces: `normalizeTitle(s) -> string`；`pickImdbMatch(film, candidates) -> candidate|null`，candidate 形如 `{tconst, primaryTitle, titleType, startYear, rating, votes}`
- Produces: `data/enriched-imdb.json` — miff-raw 的 films 每条追加 `imdb: {id, rating, votes, url} | null`

- [ ] **Step 1: 写失败测试**

`tests/imdb-match.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, pickImdbMatch } from '../scripts/lib/imdb-match.mjs';

test('normalizeTitle 去大小写/标点/变音/多空格', () => {
  assert.equal(normalizeTitle('Dead Man’s Wire'), 'dead mans wire');
  assert.equal(normalizeTitle('  Amélie: The  Movie! '), 'amelie the movie');
});

test('pickImdbMatch 年份 ±1 内取最优', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  const candidates = [
    { tconst: 'tt1', titleType: 'movie', startYear: 2010, rating: 8.0, votes: 50000 },
    { tconst: 'tt2', titleType: 'movie', startYear: 2025, rating: 7.1, votes: 3000 },
    { tconst: 'tt3', titleType: 'short', startYear: 2025, rating: 9.0, votes: 12 },
  ];
  assert.equal(pickImdbMatch(film, candidates).tconst, 'tt2'); // 年份精确 + movie 优先
});

test('pickImdbMatch 年份差超过1返回 null', () => {
  const film = { title_en: 'X', year: 2026 };
  assert.equal(pickImdbMatch(film, [{ tconst: 'tt1', titleType: 'movie', startYear: 2020, votes: 1 }]), null);
});

test('pickImdbMatch 同分候选取票数多者', () => {
  const film = { title_en: 'X', year: 2025 };
  const c = pickImdbMatch(film, [
    { tconst: 'a', titleType: 'movie', startYear: 2025, votes: 10 },
    { tconst: 'b', titleType: 'movie', startYear: 2025, votes: 9000 },
  ]);
  assert.equal(c.tconst, 'b');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/imdb-match.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `scripts/lib/imdb-match.mjs`**

```js
export function normalizeTitle(s) {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // 去变音符（勿写成字面组合字符，格式化工具会静默破坏）
    .toLowerCase()
    .replace(/[’'"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TYPE_SCORE = { movie: 3, tvMovie: 2, tvMiniSeries: 2, tvSeries: 2, short: 1 };

export function pickImdbMatch(film, candidates) {
  if (!film.year) return null;
  const eligible = candidates.filter(
    (c) => c.startYear && Math.abs(c.startYear - film.year) <= 1
  );
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    (Math.abs(a.startYear - film.year) - Math.abs(b.startYear - film.year)) ||
    ((TYPE_SCORE[b.titleType] ?? 0) - (TYPE_SCORE[a.titleType] ?? 0)) ||
    ((b.votes ?? 0) - (a.votes ?? 0))
  );
  return eligible[0];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/imdb-match.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: 实现 `scripts/enrich-imdb.mjs`**

流式单遍扫描（数据集 ~11M 行，不整表进内存）：先按归一化标题收集候选，再流式取评分。

```js
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { normalizeTitle, pickImdbMatch } from './lib/imdb-match.mjs';

const DATASETS = ['title.basics.tsv.gz', 'title.ratings.tsv.gz'];

async function ensureDatasets() {
  mkdirSync('data/cache', { recursive: true });
  for (const name of DATASETS) {
    const dest = `data/cache/${name}`;
    if (existsSync(dest)) continue;
    console.log(`下载 ${name}（约数百 MB，只需一次）...`);
    const res = await fetch(`https://datasets.imdbws.com/${name}`);
    if (!res.ok) throw new Error(`下载失败 ${name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  }
}

async function* tsvLines(path) {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line.split('\t'); continue; }
    yield line.split('\t');
  }
}

export async function enrich() {
  await ensureDatasets();
  const raw = JSON.parse(readFileSync('data/miff-raw.json', 'utf8'));
  const wanted = new Map(); // normTitle -> [film,...]
  for (const f of raw.films) {
    const key = normalizeTitle(f.title_en);
    if (!key) continue;
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(f);
  }

  // 第一遍：basics —— tconst(0) titleType(1) primaryTitle(2) originalTitle(3) ... startYear(5)
  const candidates = new Map(); // normTitle -> [{tconst,titleType,startYear,primaryTitle}]
  for await (const cols of tsvLines('data/cache/title.basics.tsv.gz')) {
    // 1100 万行的热循环，避免每行分配 Set
    const keyPrimary = normalizeTitle(cols[2]);
    const keyOriginal = cols[3] === cols[2] ? keyPrimary : normalizeTitle(cols[3]);
    for (const key of keyPrimary === keyOriginal ? [keyPrimary] : [keyPrimary, keyOriginal]) {
      if (!wanted.has(key)) continue;
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push({
        tconst: cols[0], titleType: cols[1], primaryTitle: cols[2],
        startYear: cols[5] === '\\N' ? null : Number(cols[5]),
      });
    }
  }

  // 第二遍：ratings —— tconst(0) averageRating(1) numVotes(2)
  const needed = new Set([...candidates.values()].flat().map((c) => c.tconst));
  const ratings = new Map();
  for await (const cols of tsvLines('data/cache/title.ratings.tsv.gz')) {
    if (needed.has(cols[0])) ratings.set(cols[0], { rating: Number(cols[1]), votes: Number(cols[2]) });
  }

  let matched = 0;
  const films = raw.films.map((f) => {
    const cands = (candidates.get(normalizeTitle(f.title_en)) ?? []).map((c) => ({ ...c, ...ratings.get(c.tconst) }));
    const best = pickImdbMatch(f, cands);
    if (best) matched++;
    return {
      ...f,
      imdb: best ? {
        id: best.tconst,
        rating: best.rating ?? null,
        votes: best.votes ?? null,
        url: `https://www.imdb.com/title/${best.tconst}/`,
      } : null,
    };
  });
  writeFileSync('data/enriched-imdb.json', JSON.stringify({ ...raw, films }, null, 2));
  console.log(`IMDB 匹配 ${matched}/${films.length}（电影节新片匹配不到属正常）`);
}

if (process.argv[1].endsWith('enrich-imdb.mjs')) await enrich();
```

- [ ] **Step 6: 真实运行验证**

Run: `node scripts/enrich-imdb.mjs`（首跑含下载，几分钟）
Expected: 打印匹配数（27 部预告片多为 2025/2026 新片，匹配到一部分即正常）；生成 `data/enriched-imdb.json`。抽查 2–3 个匹配到的 IMDB URL，人工打开确认是同一部片。

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/imdb-match.mjs scripts/enrich-imdb.mjs tests/imdb-match.test.mjs
git commit -m "feat: IMDB 官方数据集流式匹配评分"
```

---

### Task 4: 豆瓣匹配（尽力而为 + 优雅降级）

**Files:**
- Create: `scripts/lib/douban-match.mjs`, `scripts/enrich-douban.mjs`
- Test: `tests/douban-match.test.mjs`

**Interfaces:**
- Consumes: `data/enriched-imdb.json`（Task 3）、`politeFetch`（Task 1）
- Produces: `pickDoubanSuggest(film, suggestions) -> suggestion|null`；`parseDoubanRating(html) -> {rating, votes}`（无评分时两者 null）
- Produces: `data/enriched-douban.json` — 每条追加 `douban: {id, rating, votes, url, search_url} | {search_url}`

- [ ] **Step 1: 写失败测试**

`tests/douban-match.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDoubanSuggest, parseDoubanRating, doubanSearchUrl } from '../scripts/lib/douban-match.mjs';

test('pickDoubanSuggest 年份±1 且类型 movie', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  const s = pickDoubanSuggest(film, [
    { id: '1', title: '别的片', year: '2010', type: 'movie' },
    { id: '2', title: '亡命之绳 Dead Man’s Wire', year: '2025', type: 'movie' },
    { id: '3', title: '某本书', year: '2025', type: 'book' },
  ]);
  assert.equal(s.id, '2');
});

test('pickDoubanSuggest 无年份匹配返回 null', () => {
  assert.equal(pickDoubanSuggest({ title_en: 'X', year: 2026 }, [{ id: '1', title: 'X', year: '2000', type: 'movie' }]), null);
});

test('pickDoubanSuggest 同年份但标题不符不匹配', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  assert.equal(
    pickDoubanSuggest(film, [{ id: '9', title: '另一部片', sub_title: 'Another Film', year: '2025', type: 'movie' }]),
    null
  );
});

test('parseDoubanRating 提取评分与人数', () => {
  const html = `<strong class="ll rating_num " property="v:average">8.1</strong>
    <span property="v:votes">12345</span>`;
  assert.deepEqual(parseDoubanRating(html), { rating: 8.1, votes: 12345 });
});

test('parseDoubanRating 尚无评分返回 null', () => {
  assert.deepEqual(parseDoubanRating('<strong class="ll rating_num" property="v:average"></strong>'), { rating: null, votes: null });
});

test('doubanSearchUrl 生成电影分类搜索链接', () => {
  assert.equal(
    doubanSearchUrl('Dead Man’s Wire'),
    'https://www.douban.com/search?cat=1002&q=Dead%20Man%E2%80%99s%20Wire'
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/douban-match.test.mjs`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 `scripts/lib/douban-match.mjs`**

```js
import { normalizeTitle } from './imdb-match.mjs';

export function doubanSearchUrl(title) {
  return `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(title)}`;
}

// suggest 接口条目形如 {id, title, sub_title, year, type, url}
// 必须同时校验标题：suggest 对英文长标题常返回同年份的无关片，错误评分比没评分更糟
export function pickDoubanSuggest(film, suggestions) {
  if (!film.year || !Array.isArray(suggestions)) return null;
  const want = normalizeTitle(film.title_en);
  if (!want) return null;
  return suggestions.find((s) => {
    if (s.type !== 'movie' && s.type !== undefined) return false;
    if (!s.year || Math.abs(Number(s.year) - film.year) > 1) return false;
    // 豆瓣条目 title 常是"中文名"、sub_title 是原文名；合并归一化后要求包含英文片名
    const got = normalizeTitle(`${s.title ?? ''} ${s.sub_title ?? ''}`);
    return got.includes(want);
  }) ?? null;
}

export function parseDoubanRating(html) {
  const r = html.match(/property="v:average"[^>]*>([\d.]+)</);
  const v = html.match(/property="v:votes"[^>]*>(\d+)</);
  return {
    rating: r ? Number(r[1]) : null,
    votes: v ? Number(v[1]) : null,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/douban-match.test.mjs`
Expected: PASS（6 个测试）

- [ ] **Step 5: 实现 `scripts/enrich-douban.mjs`**

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { politeFetch } from './lib/fetch.mjs';
import { doubanSearchUrl, pickDoubanSuggest, parseDoubanRating } from './lib/douban-match.mjs';

const CACHE_DIR = 'data/cache/douban';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 豆瓣限流通常不是 403，而是 302 到 sec.douban.com 验证码页返回 200 —— 两条路径都要熔断
const DOUBAN_OPTS = () => ({
  minDelayMs: 3000 + Math.random() * 2000,
  headers: { Referer: 'https://movie.douban.com/' },
  blockedUrlPattern: /sec\.douban\.com|login\.douban\.com/,
});

async function lookupDouban(film) {
  const cachePath = `${CACHE_DIR}/${film.slug}.json`;
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'));

  const fallback = { search_url: doubanSearchUrl(film.title_en) };
  const suggestUrl = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(film.title_en)}`;
  const body = await politeFetch(suggestUrl, DOUBAN_OPTS());
  let suggestions;
  try {
    suggestions = JSON.parse(body);
  } catch {
    // 返回了 HTML 而不是 JSON：也是被反爬的表现，按 blocked 处理
    const err = new Error(`suggest 返回非 JSON（疑似验证码页）: ${body.slice(0, 80)}`);
    err.blocked = true;
    throw err;
  }
  const hit = pickDoubanSuggest(film, suggestions);
  if (!hit) return fallback;   // 未命中不写缓存：7月9日后条目可能才建立，重跑时要能重查
  const url = `https://movie.douban.com/subject/${hit.id}/`;
  const { rating, votes } = parseDoubanRating(await politeFetch(url, DOUBAN_OPTS()));
  const result = { id: String(hit.id), rating, votes, url, search_url: fallback.search_url };
  // 只缓存"有评分"的最终态；无评分的条目下次重跑要能刷新到新出的评分
  if (rating != null) writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

export async function enrich() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const raw = JSON.parse(readFileSync('data/enriched-imdb.json', 'utf8'));
  const films = [];
  let blocked = false;
  let matched = 0;
  for (const [i, f] of raw.films.entries()) {
    let douban = { search_url: doubanSearchUrl(f.title_en) };
    if (!blocked) {
      try {
        douban = await lookupDouban(f);
      } catch (e) {
        if (e.blocked) {
          blocked = true; // 被反爬：剩余影片全部降级为搜索链接，不再请求
          console.warn(`\n豆瓣在第 ${i + 1} 部时限流（${e.message}），其余降级为搜索链接。稍后重跑可续（已匹配的有缓存）。`);
        }
        // 其他错误：该片降级，不中断
      }
    }
    if (douban.rating != null) matched++;
    films.push({ ...f, douban });
    process.stdout.write(`\r[${i + 1}/${raw.films.length}] ${f.slug}          `);
  }
  console.log();
  writeFileSync('data/enriched-douban.json', JSON.stringify({ ...raw, films }, null, 2));
  console.log(`豆瓣有评分 ${matched}/${films.length}（新片无条目/无评分属正常）`);
}

if (process.argv[1].endsWith('enrich-douban.mjs')) await enrich();
```

- [ ] **Step 6: 真实运行验证**

Run: `node scripts/enrich-douban.mjs`（27 部 × 最多 2 请求 × 3–5s ≈ 2–4 分钟）
Expected: 正常结束并打印匹配统计；`data/enriched-douban.json` 每条都有 `douban` 字段且至少含 `search_url`。抽查 1–2 个匹配到的豆瓣 URL 确认是同一部片。若全程被限流，属可接受降级 —— 确认所有条目有 `search_url` 即可通过。

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/douban-match.mjs scripts/enrich-douban.mjs tests/douban-match.test.mjs
git commit -m "feat: 豆瓣尽力匹配评分，被限流时降级为搜索链接"
```

---

### Task 5: 翻译脚本 translate.mjs（claude -p + 缓存）→ site/films.json

**Files:**
- Create: `scripts/translate.mjs`
- Test: 真实运行验证（LLM 输出不做单测；结构校验内置在脚本里）

**Interfaces:**
- Consumes: `data/enriched-douban.json`（Task 4）；`claude` CLI（需已登录）
- Produces: `site/films.json` — 设计文档定义的最终数据模型数组；`data/translations/{slug}.json` 缓存（提交进 git）

- [ ] **Step 1: 实现 `scripts/translate.mjs`**

```js
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CACHE_DIR = 'data/translations';

const hashOf = (f) => createHash('sha256')
  .update([f.title_en, f.synopsis_en ?? f.blurb ?? ''].join('\n'))
  .digest('hex').slice(0, 16);

function buildPrompt(f) {
  return `你是电影节导览编辑。给中国观众翻译一部墨尔本电影节影片的资料。只输出一个 JSON 对象，不要任何其他文字或代码块标记，字段：
- "title_zh": 中文片名。若豆瓣有通行译名请用它，否则给一个自然、信达雅的译名。
- "synopsis_zh": 简介的完整中文翻译，保留原文段落结构（段落间用 \\n\\n），语气自然，不要翻译腔。
- "highlight_zh": 一句话看点（30 字以内），帮观众快速决策，突出这部片最值得看的点（阵容/奖项/题材/口碑）。

影片资料：
英文片名：${f.title_en}
导演：${f.director ?? '未知'}
年份：${f.year ?? '未知'}
国家：${(f.countries ?? []).join('、') || '未知'}
${f.premiere ? `首映级别：${f.premiere}` : ''}
${f.press_quote ? `媒体评语：${f.press_quote}` : ''}
英文简介：
${f.synopsis_en ?? f.blurb ?? '（无简介）'}`;
}

function parseModelJson(stdout) {
  const text = stdout.replace(/^```(json)?\s*|\s*```$/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`模型输出中未找到 JSON: ${text.slice(0, 200)}`);
  const obj = JSON.parse(text.slice(start, end + 1));
  for (const k of ['title_zh', 'synopsis_zh', 'highlight_zh']) {
    if (typeof obj[k] !== 'string' || !obj[k].trim()) throw new Error(`模型输出缺少字段 ${k}`);
  }
  return obj;
}

async function translateFilm(f) {
  const cachePath = `${CACHE_DIR}/${f.slug}.json`;
  const hash = hashOf(f);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.hash === hash) return cached;   // 内容没变，不重翻
  }
  const { stdout } = await exec('claude', ['-p', buildPrompt(f)], { maxBuffer: 1024 * 1024, timeout: 180000 });
  const t = { hash, ...parseModelJson(stdout) };
  writeFileSync(cachePath, JSON.stringify(t, null, 2));
  return t;
}

export async function translate() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync('site', { recursive: true });
  const raw = JSON.parse(readFileSync('data/enriched-douban.json', 'utf8'));
  const out = [];
  const errors = [];
  for (const [i, f] of raw.films.entries()) {
    let t = { title_zh: null, synopsis_zh: null, highlight_zh: null };
    try {
      t = await translateFilm(f);
      process.stdout.write(`\r[${i + 1}/${raw.films.length}] ${f.slug}          `);
    } catch (e) {
      errors.push({ slug: f.slug, error: String(e) });
    }
    out.push({
      slug: f.slug,
      title_en: f.title_en,
      title_zh: t.title_zh,
      director: f.director,
      year: f.year,
      country: (f.countries ?? []).join(' / ') || null,
      runtime: f.runtime,
      genres: f.genre ? [f.genre] : [],
      synopsis_en: f.synopsis_en,
      synopsis_zh: t.synopsis_zh,
      highlight_zh: t.highlight_zh,
      poster: f.poster ?? f.thumb,
      miff_url: f.miff_url,
      imdb: f.imdb,
      douban: f.douban,
      sessions: [],   // 7月16日排片预留
    });
  }
  console.log();
  if (errors.length) {
    const prev = existsSync('data/errors.json') ? JSON.parse(readFileSync('data/errors.json', 'utf8')) : [];
    writeFileSync('data/errors.json', JSON.stringify([...prev, ...errors.map((e) => ({ step: 'translate', ...e }))], null, 2));
    console.warn(`翻译失败 ${errors.length} 部（已保留英文原文，详见 data/errors.json）：`, errors.map((e) => e.slug).join(', '));
    if (errors.length / raw.films.length > 0.2) {
      console.error('翻译失败率超 20%，中止（检查 claude CLI 是否可用）');
      process.exit(1);
    }
  }
  writeFileSync('site/films.json', JSON.stringify(out, null, 2));
  console.log(`site/films.json 写入 ${out.length} 部影片`);
}

if (process.argv[1].endsWith('translate.mjs')) await translate();
```

- [ ] **Step 2: 先小规模验证 claude CLI 可用**

```bash
claude -p '只输出 JSON：{"ok":true}'
```

Expected: 输出含 `{"ok":true}`。若命令不存在或未登录，停下向用户报告，不要用假数据绕过。

- [ ] **Step 3: 真实运行**

Run: `node scripts/translate.mjs`（27 部 × 每部一次调用，约 5–15 分钟）
Expected: 生成 `site/films.json` 与 27 个 `data/translations/*.json`。

- [ ] **Step 4: 抽查翻译质量**

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('site/films.json'));for(const f of d.slice(0,3))console.log(f.title_en,'→',f.title_zh,'|',f.highlight_zh)"
```

Expected: 中文名自然、看点在 30 字内且信息量足。人工读 3 条确认没有翻译腔/幻觉（看点里不得出现资料里没有的奖项或事实）。

- [ ] **Step 5: 再跑一次验证缓存**

Run: `node scripts/translate.mjs`
Expected: 几秒内完成（全部命中缓存，无 claude 调用）。

- [ ] **Step 6: Commit**

```bash
git add scripts/translate.mjs data/translations/ site/films.json
git commit -m "feat: claude -p 翻译+一句话看点，按内容哈希缓存"
```

---

### Task 6: 流水线编排 build.mjs

**Files:**
- Create: `scripts/build.mjs`

**Interfaces:**
- Consumes: Task 2–5 各脚本导出的 `scrape()` / `enrich()` / `translate()`
- Produces: `npm run build`（全流程）与 `npm run build -- --step=scrape|imdb|douban|translate`

- [ ] **Step 1: 实现 `scripts/build.mjs`**

```js
const STEPS = {
  scrape: async () => (await import('./scrape-miff.mjs')).scrape(),
  imdb: async () => (await import('./enrich-imdb.mjs')).enrich(),
  douban: async () => (await import('./enrich-douban.mjs')).enrich(),
  translate: async () => (await import('./translate.mjs')).translate(),
};

const arg = process.argv.find((a) => a.startsWith('--step='));
const wanted = arg ? arg.slice('--step='.length).split(',') : Object.keys(STEPS);

for (const name of wanted) {
  if (!STEPS[name]) {
    console.error(`未知步骤 ${name}；可选：${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n=== ${name} ===`);
  await STEPS[name]();
}
```

注意：Task 2–5 的脚本用 `process.argv[1].endsWith(...)` 守卫入口，被 import 时不会自动执行，只会通过这里显式调用——实现时确认四个脚本都遵守这一点。

- [ ] **Step 2: 验证单步与全流程**

Run: `npm run build -- --step=translate`
Expected: 只跑翻译步骤，全部命中缓存秒级结束。

Run: `npm run build -- --step=imdb,translate`
Expected: 依次跑两步无报错。

- [ ] **Step 3: Commit**

```bash
git add scripts/build.mjs
git commit -m "feat: 流水线编排，支持 --step 单跑"
```

---

### Task 7: 前端静态单页（site/）

**Files:**
- Create: `site/index.html`, `site/app.js`, `site/style.css`

**Interfaces:**
- Consumes: `site/films.json`（Task 5 的数据模型）
- Produces: 可直接静态托管的 `site/` 目录

**设计要点（对照设计文档）：** 移动端优先卡片流；豆瓣绿 `#2e963d` / IMDB 黄 `#f5c518` 评分徽章；排序切换（豆瓣/IMDB/片名，无评分排最后）；点击展开完整中文简介与外链；无评分显示"暂无评分"，豆瓣无条目时用 `search_url`。

- [ ] **Step 1: 写 `site/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MIFF 2026 墨尔本电影节中文导览</title>
<meta name="description" content="墨尔本国际电影节 2026 中文片单：豆瓣/IMDB 评分、中文简介、一句话看点">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="site-header">
  <h1>MIFF 2026 中文导览</h1>
  <p class="subtitle">墨尔本国际电影节 · 片单含IMDB 评分与中文简介</p>
  <p class="notice" id="notice"></p>
  <nav class="sort-bar" id="sort-bar" aria-label="排序方式">
    <button data-sort="douban" class="active">豆瓣评分</button>
    <button data-sort="imdb">IMDB 评分</button>
    <button data-sort="title">片名</button>
  </nav>
</header>
<main id="film-list" class="film-list" aria-live="polite"></main>
<footer class="site-footer">
  <p>数据来自 <a href="https://miff.com.au/program" target="_blank" rel="noopener">MIFF 官网</a>、IMDB 与豆瓣 · 非官方站点 · 完整节目单 7 月 9 日发布</p>
</footer>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 `site/app.js`**

```js
let films = [];
let sortKey = 'douban';

const $list = document.getElementById('film-list');

const ratingOf = (f, key) =>
  key === 'douban' ? f.douban?.rating ?? null :
  key === 'imdb' ? f.imdb?.rating ?? null : null;

function sortFilms(list) {
  const copy = [...list];
  if (sortKey === 'title') {
    copy.sort((a, b) => (a.title_zh ?? a.title_en).localeCompare(b.title_zh ?? b.title_en, 'zh'));
  } else {
    copy.sort((a, b) => {
      const ra = ratingOf(a, sortKey), rb = ratingOf(b, sortKey);
      if (ra == null && rb == null) return (a.title_en ?? '').localeCompare(b.title_en ?? '');
      if (ra == null) return 1;              // 无评分排最后
      if (rb == null) return -1;
      return rb - ra;
    });
  }
  return copy;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function badge(cls, label, rating, url) {
  const text = rating != null ? rating.toFixed(1) : '暂无';
  const inner = `<span class="badge ${cls}${rating == null ? ' none' : ''}">${label} ${text}</span>`;
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${inner}</a>` : inner;
}

function card(f) {
  const meta = [f.director, f.year, f.country, f.runtime ? `${f.runtime} 分钟` : null]
    .filter(Boolean).join(' · ');
  const doubanUrl = f.douban?.url ?? f.douban?.search_url;
  const synopsis = (f.synopsis_zh ?? f.synopsis_en ?? '').split('\n\n')
    .map((p) => `<p>${esc(p)}</p>`).join('');
  const posterHtml = f.poster
    ? `<img class="poster" src="${esc(f.poster)}" alt="${esc(f.title_zh ?? f.title_en)} 海报" loading="lazy">`
    : '<div class="poster poster-empty"></div>';
  return `<article class="card" data-slug="${esc(f.slug)}">
    ${posterHtml}
    <div class="card-body">
      <h2>${esc(f.title_zh ?? f.title_en)}</h2>
      <p class="title-en">${esc(f.title_en)}</p>
      <div class="badges">
        ${badge('douban', '豆瓣', f.douban?.rating ?? null, doubanUrl)}
        ${badge('imdb', 'IMDB', f.imdb?.rating ?? null, f.imdb?.url)}
      </div>
      ${f.highlight_zh ? `<p class="highlight">💡 ${esc(f.highlight_zh)}</p>` : ''}
      <p class="meta">${esc(meta)}</p>
      <div class="detail" hidden>
        ${synopsis}
        <p class="links">
          <a href="${esc(f.miff_url)}" target="_blank" rel="noopener">MIFF 官网页面 ↗</a>
          ${doubanUrl ? `<a href="${esc(doubanUrl)}" target="_blank" rel="noopener">${f.douban?.url ? '豆瓣条目' : '豆瓣搜索'} ↗</a>` : ''}
          ${f.imdb?.url ? `<a href="${esc(f.imdb.url)}" target="_blank" rel="noopener">IMDB ↗</a>` : ''}
        </p>
      </div>
    </div>
  </article>`;
}

function render() {
  $list.innerHTML = sortFilms(films).map(card).join('');
}

document.getElementById('sort-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn) return;
  sortKey = btn.dataset.sort;
  document.querySelectorAll('.sort-bar button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

$list.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;         // 点外链不触发展开
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const d = cardEl.querySelector('.detail');
  d.hidden = !d.hidden;
});

fetch('films.json')
  .then((r) => r.json())
  .then((data) => {
    films = data;
    document.getElementById('notice').textContent = `共 ${films.length} 部影片`;
    render();
  })
  .catch(() => {
    $list.innerHTML = '<p class="error">片单加载失败，请刷新重试。</p>';
  });
```

- [ ] **Step 3: 写 `site/style.css`**

```css
:root {
  --douban: #2e963d;
  --imdb: #f5c518;
  --bg: #101014;
  --card: #1a1a21;
  --text: #ececf0;
  --muted: #9a9aa5;
  --accent: #e8452c;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}
.site-header { padding: 24px 16px 8px; max-width: 720px; margin: 0 auto; }
.site-header h1 { margin: 0; font-size: 1.6rem; }
.subtitle, .notice { color: var(--muted); font-size: .9rem; margin: 4px 0; }
.sort-bar { display: flex; gap: 8px; margin: 12px 0; }
.sort-bar button {
  background: var(--card); color: var(--text); border: 1px solid #333;
  border-radius: 999px; padding: 6px 14px; font-size: .9rem; cursor: pointer;
}
.sort-bar button.active { background: var(--accent); border-color: var(--accent); }
.film-list { max-width: 720px; margin: 0 auto; padding: 0 16px 40px; display: grid; gap: 16px; }
.card {
  background: var(--card); border-radius: 12px; overflow: hidden; cursor: pointer;
  display: grid; grid-template-columns: 120px 1fr;
}
.poster { width: 120px; height: 100%; min-height: 160px; object-fit: cover; background: #000; }
.card-body { padding: 12px 14px; min-width: 0; }
.card-body h2 { margin: 0; font-size: 1.1rem; }
.title-en { color: var(--muted); font-size: .85rem; margin: 2px 0 8px; }
.badges { display: flex; gap: 8px; margin-bottom: 8px; }
.badges a { text-decoration: none; }
.badge { font-size: .8rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; color: #000; }
.badge.douban { background: var(--douban); color: #fff; }
.badge.imdb { background: var(--imdb); }
.badge.none { background: #333; color: var(--muted); font-weight: 400; }
.highlight { font-size: .92rem; margin: 6px 0; }
.meta { color: var(--muted); font-size: .8rem; margin: 4px 0; }
.detail { font-size: .92rem; border-top: 1px solid #2a2a33; margin-top: 8px; padding-top: 8px; }
.detail p { margin: 0 0 8px; }
.links a { color: var(--accent); margin-right: 12px; }
.site-footer { text-align: center; color: var(--muted); font-size: .8rem; padding: 16px; }
.error { color: var(--accent); text-align: center; }
@media (max-width: 480px) {
  .card { grid-template-columns: 96px 1fr; }
  .poster { width: 96px; }
}
```

- [ ] **Step 4: 本地起服务人工+自动验证**

```bash
cd site && python3 -m http.server 8321 &
```

用 Playwright MCP 打开 `http://localhost:8321`，验证并截图：
1. 卡片流渲染，数量等于 films.json 条数
2. 默认豆瓣排序：有评分的在前且降序，"暂无"在后
3. 点"IMDB 评分"/"片名"排序变化正确
4. 点卡片展开中文简介与外链，点徽章跳外站（新标签）
5. 视口切到 390×844（iPhone）截图，布局不破
完成后 kill 掉 http.server。

- [ ] **Step 5: Commit**

```bash
git add site/
git commit -m "feat: 中文导览静态单页（评分徽章/排序/展开详情）"
```

---

### Task 8: 全流程串测 + README + 部署准备

**Files:**
- Create: `README.md`
- Modify: 无（发现问题才改）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 干净全流程**

```bash
rm -f data/miff-raw.json data/enriched-imdb.json data/enriched-douban.json
npm run build
npm test
```

Expected: 四步全绿（translate 全命中缓存）、所有测试通过、`site/films.json` 重新生成且条数不变。

- [ ] **Step 2: 写 `README.md`**

```markdown
# MIFF 2026 中文导览

墨尔本国际电影节非官方中文片单：豆瓣/IMDB 评分 + 中文简介 + 一句话看点。

## 更新数据（7月9日全量节目单发布后执行）

​```bash
npm install
npm run build        # scrape → imdb → douban → translate，产出 site/films.json
npm test
​```

- 已翻译影片按内容哈希缓存于 `data/translations/`，只翻新片；全量数百部首次翻译为串行 claude 调用，预计 1–2 小时
- 若列表页抓取因"分页/懒加载标记"报错退出：官网已改版为分页，需改 `scrape-miff.mjs` 的 slug 枚举逻辑
- 单跑某步：`npm run build -- --step=douban`
- 豆瓣被限流：稍后重跑 `--step=douban,translate`（已匹配的有缓存）
- 抓取失败清单：`data/errors.json`
- 若官网改版导致完整性校验退出：改 `scripts/lib/parse-miff.mjs` 的选择器，
  用 `tests/fixtures/` 重抓 fixture 后跑 `npm test`

## 部署

`site/` 即完整站点。Cloudflare Pages：build command 留空，output directory 填 `site`。

## 7月16日开票后（暂未实现）

各片 `item_hash` 非空后，可调 `https://tix.miff.com.au/api/v1/Items/DatesCached?itemHash=...`
拿排片写入 `sessions` 字段，前端已预留该字段。
​```

（注意：上面代码块围栏中的 `​` 零宽字符仅为本计划文档嵌套需要，写入真实 README 时用普通 ``` 围栏。）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 使用与更新说明"
```

---

## Self-Review 结论（已执行）

- **Spec coverage:** 抓取（T1/T2）、IMDB（T3）、豆瓣+降级（T4）、翻译+看点+缓存（T5）、编排与 7月9日重跑（T6/README）、前端排序/徽章/展开/移动端（T7）、完整性校验（T2）、验证方式（T7 Step4 / T8 Step1）均有对应任务。部署到 Cloudflare Pages 需要用户账号，README 给出配置，实际接入由用户决定。
- **Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency:** `scrape()/enrich()/enrich()/translate()` 导出名与 build.mjs 调用一致；`films.json` 字段与前端 app.js 读取字段一致（douban.rating/url/search_url、imdb.rating/url、highlight_zh、synopsis_zh、sessions）。
