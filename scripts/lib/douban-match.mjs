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
