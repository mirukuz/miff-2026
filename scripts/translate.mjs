import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CACHE_DIR = 'data/translations';

// 抓取到的页面文本（简介/媒体评语等）会流入下面的 prompt；输出被约束为三个校验过的字符串字段，
// 提示注入风险已识别并被限定在有限范围内。
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

// 缓存哈希覆盖 buildPrompt 的完整输出，确保任何会影响翻译结果的字段（导演/年份/国家/首映/媒体评语等）
// 变化时都能使缓存失效，而不仅是标题和简介。
const hashOf = (f) => createHash('sha256').update(buildPrompt(f)).digest('hex').slice(0, 16);

// 模型偶尔在字符串值里输出未转义的英文双引号（如 自称"作者"）。真正的结构引号后面必然紧跟
// ASCII 的 : , } ]（中文文本用全角标点），据此把内容引号转义后重新解析。
function repairUnescapedQuotes(json) {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === '\\') { out += c + (json[++i] ?? ''); continue; }
    if (c === '"') {
      const rest = json.slice(i + 1).match(/^\s*(.)/);
      if (!rest || [':', ',', '}', ']'].includes(rest[1])) { inString = false; out += c; }
      else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}

export function parseModelJson(stdout) {
  const text = stdout.replace(/^```(json)?\s*|\s*```$/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`模型输出中未找到 JSON: ${text.slice(0, 200)}`);
  const slice = text.slice(start, end + 1);
  let obj;
  try {
    obj = JSON.parse(slice);
  } catch {
    obj = JSON.parse(repairUnescapedQuotes(slice));
  }
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
  // 模型偶尔输出不合法 JSON（字符串内未转义的引号等），属间歇性问题，解析失败时重试
  const MAX_ATTEMPTS = 3;
  let parsed;
  for (let attempt = 1; ; attempt++) {
    const { stdout } = await exec('claude', ['-p', buildPrompt(f)], {
      maxBuffer: 1024 * 1024,
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      parsed = parseModelJson(stdout);
      break;
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw e;
    }
  }
  const t = { hash, ...parsed };
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
  // 无论成败都重写 errors.json 的 translate 部分，避免旧错误在全部成功后残留
  const prevAll = existsSync('data/errors.json') ? JSON.parse(readFileSync('data/errors.json', 'utf8')) : [];
  const prev = prevAll.filter((e) => e.step !== 'translate');
  writeFileSync('data/errors.json', JSON.stringify([...prev, ...errors.map((e) => ({ step: 'translate', ...e }))], null, 2));
  if (errors.length) {
    console.warn(`翻译失败 ${errors.length} 部（已保留英文原文，详见 data/errors.json）：`, errors.map((e) => e.slug).join(', '));
    if (errors.length / raw.films.length > 0.2) {
      console.error('翻译失败率超 20%，中止（检查 claude CLI 是否可用）');
      process.exit(1);
    }
  }
  writeFileSync('site/films.json', JSON.stringify(out, null, 2));
  console.log(`site/films.json 写入 ${out.length} 部影片`);
}

if (process.argv[1]?.endsWith('translate.mjs')) await translate();
