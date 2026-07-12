import { mkdirSync, writeFileSync } from 'node:fs';
import { politeFetch } from './lib/fetch.mjs';
import { parseProgramPage, parseNextPageUrl } from './lib/parse-miff.mjs';

const BASE = 'https://miff.com.au';
const MAX_PAGES = 20;

// 官网 /program/browse/genre 下的全部分类（页面结构与主片单一致，直接复用解析器）
export const GENRES = [
  'action-adventure', 'animation', 'comedy', 'crime', 'dance', 'documentary',
  'drama', 'experimental', 'fantasy', 'historical', 'horror', 'mockumentary',
  'music', 'musical', 'mystery', 'period', 'romance', 'sci-fi', 'thriller',
];

async function crawlGenre(genre, fetchFn) {
  const slugs = new Set();
  let url = `${BASE}/program/browse/genre/${genre}`;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`${genre} 超过 ${MAX_PAGES} 页上限`);
    const html = await fetchFn(url);
    for (const card of parseProgramPage(html)) slugs.add(card.slug);
    const next = parseNextPageUrl(html);
    url = next ? new URL(next, BASE).href : null;
  }
  return slugs;
}

export async function enrich({ fetchFn = politeFetch } = {}) {
  mkdirSync('data', { recursive: true });
  const bySlug = {};
  for (const genre of GENRES) {
    const slugs = await crawlGenre(genre, fetchFn);
    for (const slug of slugs) (bySlug[slug] ??= []).push(genre);
    console.log(`${genre}: ${slugs.size} 部`);
  }
  writeFileSync('data/genres.json', JSON.stringify(bySlug, null, 2));
  console.log(`data/genres.json 写入 ${Object.keys(bySlug).length} 部影片的题材`);
}

if (process.argv[1]?.endsWith('enrich-genres.mjs')) await enrich();
