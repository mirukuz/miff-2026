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

  // 完整性校验：防官网改版后静默产出坏数据。
  // 详情页缺长简介但列表页有 blurb 的算合格（翻译步骤以 blurb 兜底）。
  const bad = films.filter((f) => !f.title_en || (!f.synopsis_en && !f.blurb)).length + errors.length;
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
