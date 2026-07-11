import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pickRtHit, rtResultOf, rtSearchUrl } from './lib/rt-match.mjs';

const CACHE_DIR = 'data/cache/rt';

// 烂番茄官网前端使用的 Algolia 公开搜索凭据（只读、随页面下发，非私密 key）
const ALGOLIA_URL = 'https://79frdp12pn-dsn.algolia.net/1/indexes/content_rt/query';
const ALGOLIA_HEADERS = {
  'x-algolia-application-id': '79FRDP12PN',
  'x-algolia-api-key': '175588f6e5f8319b27702e4cc4013561',
  'content-type': 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchRt(query, fetchImpl = fetch) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(ALGOLIA_URL, {
        method: 'POST',
        headers: ALGOLIA_HEADERS,
        body: JSON.stringify({ query, hitsPerPage: 8, filters: 'type:movie' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).hits ?? [];
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

export async function lookupRt(film, { cacheDir = CACHE_DIR, fetchImpl = fetch } = {}) {
  const cachePath = `${cacheDir}/${film.slug}.json`;
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'));

  const searchUrl = rtSearchUrl(film.title_en);
  const fallback = { search_url: searchUrl };
  const hit = pickRtHit(film, await searchRt(film.title_en, fetchImpl));
  if (!hit) return fallback;   // 未命中不写缓存：条目可能后建，重跑时要能重查
  const result = rtResultOf(hit, searchUrl);
  // 只缓存"有评分"的最终态；无评分的条目下次重跑要能刷新到新出的评分
  if (result.critics_score != null) writeFileSync(cachePath, JSON.stringify(result));
  return result;
}

export async function enrich() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const raw = JSON.parse(readFileSync('data/enriched-douban.json', 'utf8'));
  const films = [];
  let matched = 0;
  for (const [i, f] of raw.films.entries()) {
    let rt = { search_url: rtSearchUrl(f.title_en) };
    try {
      rt = await lookupRt(f);
      await sleep(150); // 对 Algolia 保持礼貌节流
    } catch {
      // 单片失败降级为搜索链接，不中断
    }
    if (rt.critics_score != null) matched++;
    films.push({ ...f, rt });
    process.stdout.write(`\r[${i + 1}/${raw.films.length}] ${f.slug}          `);
  }
  console.log();
  writeFileSync('data/enriched-rt.json', JSON.stringify({ ...raw, films }, null, 2));
  console.log(`烂番茄有评分 ${matched}/${films.length}（新片无条目/无评分属正常）`);
}

if (process.argv[1]?.endsWith('enrich-rt.mjs')) await enrich();
