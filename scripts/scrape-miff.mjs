import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { politeFetch } from './lib/fetch.mjs';
import { parseProgramPage, parseFilmPage, parseNextPageUrl, parseMaxPage } from './lib/parse-miff.mjs';

const BASE = 'https://miff.com.au';
const LIST_URL = `${BASE}/program/films`;
const MAX_PAGES = 50;

// 全量片单（7月9日上线）的列表页是 Laravel 分页器：?page=N，下一页链接带 rel="next"。
// 沿 rel="next" 走到底，按 slug 去重累积所有卡片。
export async function crawlListPages(fetchFn = politeFetch) {
  const bySlug = new Map();
  let url = LIST_URL;
  let pagesFetched = 0;
  let maxPageSeen = 1;
  while (url) {
    if (pagesFetched >= MAX_PAGES) {
      throw new Error(`列表页超过 ${MAX_PAGES} 页上限 —— rel="next" 链疑似成环`);
    }
    const html = await fetchFn(url);
    pagesFetched += 1;
    const pageCards = parseProgramPage(html);
    if (pageCards.length === 0) {
      throw new Error(`第 ${pagesFetched} 页解析出 0 部影片（${url}）—— 官网结构可能已改版`);
    }
    const before = bySlug.size;
    for (const card of pageCards) if (!bySlug.has(card.slug)) bySlug.set(card.slug, card);
    if (bySlug.size === before) {
      throw new Error(`第 ${pagesFetched} 页没有任何新影片（${url}）—— 分页疑似原地循环`);
    }
    maxPageSeen = Math.max(maxPageSeen, parseMaxPage(html));
    const next = parseNextPageUrl(html);
    url = next ? new URL(next, BASE).href : null;
  }
  return { cards: [...bySlug.values()], pagesFetched, maxPageSeen };
}

// 截断检测：分页已被 crawlListPages 处理，这里守住"抓到的确实是全量"。
export function assertNotTruncated(cards, { pagesFetched, maxPageSeen }) {
  if (cards.length === 0) throw new Error('列表页解析出 0 部影片 —— 官网结构可能已改版');
  if (pagesFetched < maxPageSeen) {
    throw new Error(`分页器显示至少 ${maxPageSeen} 页但只抓到 ${pagesFetched} 页 —— rel="next" 链断裂，列表被截断`);
  }
  if (existsSync('data/miff-raw.json')) {
    const prev = JSON.parse(readFileSync('data/miff-raw.json', 'utf8')).films.length;
    if (cards.length < prev * 0.5) {
      throw new Error(`影片数从上次的 ${prev} 骤降到 ${cards.length} —— 疑似列表截断，如确认官网真的缩减了片单，删除 data/miff-raw.json 后重跑`);
    }
  }
}

export async function scrape({ listOnly = false, limit = 0 } = {}) {
  mkdirSync('data', { recursive: true });
  const { cards: allCards, pagesFetched, maxPageSeen } = await crawlListPages();
  assertNotTruncated(allCards, { pagesFetched, maxPageSeen });
  console.log(`列表页共 ${pagesFetched} 页，发现 ${allCards.length} 部影片`);
  if (listOnly) return;
  // --limit 抽样跑时写 sample 文件，避免污染 miff-raw.json 的回归守卫基线
  const cards = limit > 0 ? allCards.slice(0, limit) : allCards;
  const outFile = limit > 0 ? 'data/miff-raw.sample.json' : 'data/miff-raw.json';

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

  // 完整性校验：防官网改版后静默产出坏数据。
  // 详情页缺长简介但列表页有 blurb 的算合格（翻译步骤以 blurb 兜底）。
  const bad = films.filter((f) => !f.title_en || (!f.synopsis_en && !f.blurb)).length + errors.length;
  const ratio = bad / cards.length;
  writeFileSync('data/errors.json', JSON.stringify(errors, null, 2));
  if (ratio > 0.2) {
    console.error(`完整性校验失败：${bad}/${cards.length} 部影片缺标题或简介（>${20}%）。检查 data/errors.json 与解析器选择器。`);
    process.exit(1);
  }
  writeFileSync(outFile, JSON.stringify({ scraped_at: new Date().toISOString(), films }, null, 2));
  console.log(`完成：${films.length} 部影片写入 ${outFile}；${errors.length} 个错误见 data/errors.json`);
}

if (process.argv[1]?.endsWith('scrape-miff.mjs')) {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  await scrape({
    listOnly: args.includes('--list-only'),
    limit: limitArg ? Number(limitArg.split('=')[1]) : 0,
  });
}
