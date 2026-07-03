import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDoubanSuggest, parseDoubanRating, doubanSearchUrl } from '../scripts/lib/douban-match.mjs';

test('pickDoubanSuggest 年份±1 且类型 movie', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  const s = pickDoubanSuggest(film, [
    { id: '1', title: '别的片', year: '2010', type: 'movie' },
    { id: '2', title: '亡命之绳 Dead Man’s Wire', year: '2025', type: 'movie' },
    { id: '3', title: '某本书', year: '2025', type: 'book' },
  ]);
  assert.equal(s.id, '2');
});

test('pickDoubanSuggest 无年份匹配返回 null', () => {
  assert.equal(pickDoubanSuggest({ title_en: 'X', year: 2026 }, [{ id: '1', title: 'X', year: '2000', type: 'movie' }]), null);
});

test('pickDoubanSuggest 同年份但标题不符不匹配', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  assert.equal(
    pickDoubanSuggest(film, [{ id: '9', title: '另一部片', sub_title: 'Another Film', year: '2025', type: 'movie' }]),
    null
  );
});

test('pickDoubanSuggest 无 type 字段的条目不匹配', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  assert.equal(
    pickDoubanSuggest(film, [{ id: '4', title: '亡命之绳 Dead Man’s Wire', year: '2025' }]),
    null
  );
});

test('parseDoubanRating 提取评分与人数', () => {
  const html = `<strong class="ll rating_num " property="v:average">8.1</strong>
    <span property="v:votes">12345</span>`;
  assert.deepEqual(parseDoubanRating(html), { rating: 8.1, votes: 12345 });
});

test('parseDoubanRating 尚无评分返回 null', () => {
  assert.deepEqual(parseDoubanRating('<strong class="ll rating_num" property="v:average"></strong>'), { rating: null, votes: null });
});

test('doubanSearchUrl 生成电影分类搜索链接', () => {
  assert.equal(
    doubanSearchUrl('Dead Man’s Wire'),
    'https://www.douban.com/search?cat=1002&q=Dead%20Man%E2%80%99s%20Wire'
  );
});
