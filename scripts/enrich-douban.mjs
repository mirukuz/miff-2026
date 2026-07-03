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
