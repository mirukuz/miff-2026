import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRtHit, rtResultOf, rtSearchUrl } from '../scripts/lib/rt-match.mjs';

const hit = (over = {}) => ({
  title: 'Vertigo',
  titles: ['Vertigo'],
  aka: ['Vértigo'],
  vanity: 'vertigo',
  releaseYear: 1958,
  rottenTomatoes: { criticsScore: 94, audienceScore: 92 },
  ...over,
});

test('pickRtHit 标题精确归一化匹配且年份±1', () => {
  const film = { title_en: 'Vertigo', year: 1958 };
  assert.equal(pickRtHit(film, [hit()])?.vanity, 'vertigo');
  assert.equal(pickRtHit({ ...film, year: 1959 }, [hit()])?.vanity, 'vertigo');
});

test('pickRtHit 年份差超 1 或标题不同返回 null（拒绝同名旧片）', () => {
  assert.equal(pickRtHit({ title_en: 'Vertigo', year: 2026 }, [hit()]), null);
  assert.equal(pickRtHit({ title_en: 'Vertigo Sea', year: 1958 }, [hit()]), null);
});

test('pickRtHit 通过 aka 别名匹配', () => {
  assert.equal(pickRtHit({ title_en: 'Vértigo', year: 1958 }, [hit()])?.vanity, 'vertigo');
});

test('pickRtHit 缺 vanity/年份/输入非数组时安全返回 null', () => {
  assert.equal(pickRtHit({ title_en: 'Vertigo', year: 1958 }, [hit({ vanity: null })]), null);
  assert.equal(pickRtHit({ title_en: 'Vertigo', year: null }, [hit()]), null);
  assert.equal(pickRtHit({ title_en: 'Vertigo', year: 1958 }, null), null);
});

test('rtResultOf 组装评分与条目链接，缺分数时为 null', () => {
  const r = rtResultOf(hit(), rtSearchUrl('Vertigo'));
  assert.equal(r.critics_score, 94);
  assert.equal(r.audience_score, 92);
  assert.equal(r.url, 'https://www.rottentomatoes.com/m/vertigo');
  assert.match(r.search_url, /search\?search=Vertigo/);
  assert.equal(rtResultOf(hit({ rottenTomatoes: undefined }), '').critics_score, null);
});
