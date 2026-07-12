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

async function crawlListing(startUrl, fetchFn) {
  const slugs = new Set();
  let url = startUrl;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`${startUrl} 超过 ${MAX_PAGES} 页上限`);
    const html = await fetchFn(url);
    for (const card of parseProgramPage(html)) slugs.add(card.slug);
    const next = parseNextPageUrl(html);
    url = next ? new URL(next, BASE).href : null;
  }
  return slugs;
}

// strand（专题单元）每年都变，从 /program/strands 动态提取列表而非硬编码
export async function fetchStrandList(fetchFn = politeFetch) {
  const html = await fetchFn(`${BASE}/program/strands`);
  return [...new Set([...html.matchAll(/href="[^"]*\/program\/strand\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
}

async function crawlTaxonomy(entries, urlOf, outFile, label, fetchFn) {
  const bySlug = {};
  for (const key of entries) {
    const slugs = await crawlListing(urlOf(key), fetchFn);
    for (const slug of slugs) (bySlug[slug] ??= []).push(key);
    console.log(`${key}: ${slugs.size} 部`);
  }
  writeFileSync(outFile, JSON.stringify(bySlug, null, 2));
  console.log(`${outFile} 写入 ${Object.keys(bySlug).length} 部影片的${label}`);
}

export async function enrich({ fetchFn = politeFetch } = {}) {
  mkdirSync('data', { recursive: true });
  await crawlTaxonomy(GENRES, (g) => `${BASE}/program/browse/genre/${g}`, 'data/genres.json', '题材', fetchFn);
  const strands = await fetchStrandList(fetchFn);
  console.log(`\n发现 ${strands.length} 个专题单元`);
  await crawlTaxonomy(strands, (s) => `${BASE}/program/strand/${s}`, 'data/strands.json', '专题', fetchFn);
}

if (process.argv[1]?.endsWith('enrich-genres.mjs')) await enrich();
