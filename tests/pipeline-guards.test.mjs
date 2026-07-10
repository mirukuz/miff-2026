import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNotTruncated, crawlListPages } from '../scripts/scrape-miff.mjs';
import { parseModelJson } from '../scripts/translate.mjs';

// assertNotTruncated 的骤降检测会读取 cwd 下的 data/miff-raw.json（存在时）。
// 切到临时目录使该检测短路，测试与仓库真实数据完全解耦——无论 7月9日 全量抓取后
// prev 变成多少，这些用例都保持确定性。node --test 每个测试文件独立进程，chdir 安全。
process.chdir(mkdtempSync(join(tmpdir(), 'pipeline-guards-')));

const CARD_COUNT = 27;
const cards = Array.from({ length: CARD_COUNT }, (_, i) => ({ slug: `film-${i}` }));

test('assertNotTruncated 抓满全部页时不报错', () => {
  assert.doesNotThrow(() => assertNotTruncated(cards, { pagesFetched: 8, maxPageSeen: 8 }));
});

test('assertNotTruncated 在抓到页数少于分页器最大页码时报错', () => {
  assert.throws(() => assertNotTruncated(cards, { pagesFetched: 3, maxPageSeen: 8 }), /列表被截断/);
});

test('assertNotTruncated 在 0 部影片时报错', () => {
  assert.throws(() => assertNotTruncated([], { pagesFetched: 1, maxPageSeen: 1 }), /0 部影片/);
});

// crawlListPages 用桩 fetchFn 测试，不发真实请求
const card = (slug) => `<div class="film-card"><h3><a href="/program/film/${slug}#top">${slug}</a></h3></div>`;
const pager = (next) => (next ? `<a href="${next}" rel="next">Next</a>` : '');

test('crawlListPages 沿 rel="next" 抓完所有页并按 slug 去重', async () => {
  const pages = {
    'https://miff.com.au/program/films':
      card('a') + card('b') + '<a href="/program/films?page=2">2</a>' + pager('/program/films?page=2'),
    'https://miff.com.au/program/films?page=2': card('b') + card('c') + pager(null),
  };
  const { cards: got, pagesFetched, maxPageSeen } = await crawlListPages(async (url) => pages[url]);
  assert.deepEqual(got.map((c) => c.slug), ['a', 'b', 'c']);
  assert.equal(pagesFetched, 2);
  assert.equal(maxPageSeen, 2);
});

test('crawlListPages 在某页 0 卡片时报错', async () => {
  await assert.rejects(() => crawlListPages(async () => '<div>empty</div>'), /0 部影片/);
});

test('crawlListPages 在下一页无新影片（原地循环）时报错', async () => {
  const html = card('a') + pager('/program/films?page=1');
  await assert.rejects(() => crawlListPages(async () => html), /原地循环/);
});

test('crawlListPages 在超过页数上限时报错', async () => {
  let n = 0;
  const fetchFn = async () => card(`film-${n++}`) + pager(`/program/films?page=${n + 1}`);
  await assert.rejects(() => crawlListPages(fetchFn), /上限/);
});

test('parseModelJson 解析干净的 JSON', () => {
  const out = parseModelJson(JSON.stringify({
    title_zh: '标题', synopsis_zh: '简介', highlight_zh: '看点',
  }));
  assert.equal(out.title_zh, '标题');
  assert.equal(out.synopsis_zh, '简介');
  assert.equal(out.highlight_zh, '看点');
});

test('parseModelJson 解析被 ```json 代码块包裹的 JSON', () => {
  const wrapped = '```json\n' + JSON.stringify({
    title_zh: '标题', synopsis_zh: '简介', highlight_zh: '看点',
  }) + '\n```';
  const out = parseModelJson(wrapped);
  assert.equal(out.title_zh, '标题');
});

test('parseModelJson 在缺字段时报错', () => {
  const missing = JSON.stringify({ title_zh: '标题', synopsis_zh: '简介' });
  assert.throws(() => parseModelJson(missing), /缺少字段/);
});

test('parseModelJson 对非 JSON 垃圾输出报错', () => {
  assert.throws(() => parseModelJson('抱歉，我无法完成这个请求。'), /未找到 JSON/);
});
