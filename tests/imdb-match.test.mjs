import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, pickImdbMatch } from '../scripts/lib/imdb-match.mjs';

test('normalizeTitle 去大小写/标点/变音/多空格', () => {
  assert.equal(normalizeTitle('Dead Man’s Wire'), 'dead mans wire');
  assert.equal(normalizeTitle('  Amélie: The  Movie! '), 'amelie the movie');
});

test('pickImdbMatch 年份 ±1 内取最优', () => {
  const film = { title_en: 'Dead Man’s Wire', year: 2025 };
  const candidates = [
    { tconst: 'tt1', titleType: 'movie', startYear: 2010, rating: 8.0, votes: 50000 },
    { tconst: 'tt2', titleType: 'movie', startYear: 2025, rating: 7.1, votes: 3000 },
    { tconst: 'tt3', titleType: 'short', startYear: 2025, rating: 9.0, votes: 12 },
  ];
  assert.equal(pickImdbMatch(film, candidates).tconst, 'tt2'); // 年份精确 + movie 优先
});

test('pickImdbMatch 年份差超过1返回 null', () => {
  const film = { title_en: 'X', year: 2026 };
  assert.equal(pickImdbMatch(film, [{ tconst: 'tt1', titleType: 'movie', startYear: 2020, votes: 1 }]), null);
});

test('pickImdbMatch 同分候选取票数多者', () => {
  const film = { title_en: 'X', year: 2025 };
  const c = pickImdbMatch(film, [
    { tconst: 'a', titleType: 'movie', startYear: 2025, votes: 10 },
    { tconst: 'b', titleType: 'movie', startYear: 2025, votes: 9000 },
  ]);
  assert.equal(c.tconst, 'b');
});
