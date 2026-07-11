import { normalizeTitle } from './imdb-match.mjs';

export function rtSearchUrl(title) {
  return `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;
}

// Algolia 命中条目形如 {title, titles, aka, vanity, releaseYear, rottenTomatoes: {criticsScore, audienceScore}}
// 与豆瓣同理必须校验标题 + 年份：搜索对短片/新片常返回同名旧片，错误评分比没评分更糟
export function pickRtHit(film, hits) {
  if (!film.year || !Array.isArray(hits)) return null;
  const want = normalizeTitle(film.title_en);
  if (!want) return null;
  return hits.find((h) => {
    if (!h.vanity) return false;
    if (!h.releaseYear || Math.abs(Number(h.releaseYear) - film.year) > 1) return false;
    const names = [h.title, ...(h.titles ?? []), ...(h.aka ?? [])];
    return names.some((n) => normalizeTitle(n) === want);
  }) ?? null;
}

export function rtResultOf(hit, searchUrl) {
  const scores = hit.rottenTomatoes ?? {};
  return {
    critics_score: scores.criticsScore ?? null,   // 番茄新鲜度（0-100）
    audience_score: scores.audienceScore ?? null, // 观众爆米花分（0-100）
    url: `https://www.rottentomatoes.com/m/${hit.vanity}`,
    search_url: searchUrl,
  };
}
