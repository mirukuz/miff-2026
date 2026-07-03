import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotTruncated } from '../scripts/scrape-miff.mjs';
import { parseModelJson } from '../scripts/translate.mjs';

// data/miff-raw.json (if present) currently holds 27 films; assertNotTruncated's
// prev-count guard throws if cards.length < prev * 0.5. Use >=27 cards here so
// these tests stay deterministic regardless of that file's presence/content.
const CARD_COUNT = 27;
const cards = Array.from({ length: CARD_COUNT }, (_, i) => ({ slug: `film-${i}` }));

test('assertNotTruncated 对提及 "MIFF 2026 Films" 的正常页面不报错', () => {
  const html = '<title>MIFF 2026 Films</title><div>Browse the full programme below.</div>';
  assert.doesNotThrow(() => assertNotTruncated(html, cards));
});

test('assertNotTruncated 在声称总数远大于解析数时报错', () => {
  const html = '<div>showing 300 films</div>';
  assert.throws(() => assertNotTruncated(html, cards), /列表被截断/);
});

test('assertNotTruncated 在出现真实分页标记时报错', () => {
  const html = '<button onclick="loadMore()">load more</button>';
  assert.throws(() => assertNotTruncated(html, cards), /分页\/懒加载标记/);
});

test('assertNotTruncated 不因 "Download more" 而误报', () => {
  const html = '<a href="/programme.pdf">Download more information</a>';
  assert.doesNotThrow(() => assertNotTruncated(html, cards));
});

test('assertNotTruncated 在 0 部影片时报错', () => {
  assert.throws(() => assertNotTruncated('<div>empty</div>', []), /0 部影片/);
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
