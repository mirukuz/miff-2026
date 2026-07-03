import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupDouban } from '../scripts/enrich-douban.mjs';

const neverFetch = async () => {
  throw new Error('blocked 状态下不应发起网络请求');
};

test('lookupDouban 熔断后仍读缓存（缓存不受 blocked 门控）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'douban-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cached = {
    id: '37925641',
    rating: 8.1,
    votes: 12345,
    url: 'https://movie.douban.com/subject/37925641/',
    search_url: 'https://www.douban.com/search?cat=1002&q=X',
  };
  writeFileSync(join(dir, 'some-film.json'), JSON.stringify(cached));

  const result = await lookupDouban(
    { slug: 'some-film', title_en: 'X', year: 2025 },
    { cacheDir: dir, blocked: true, fetchImpl: neverFetch }
  );
  assert.deepEqual(result, cached);
});

test('lookupDouban 熔断且无缓存时降级为搜索链接，不发请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'douban-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await lookupDouban(
    { slug: 'no-cache-film', title_en: 'Dead Man’s Wire', year: 2025 },
    { cacheDir: dir, blocked: true, fetchImpl: neverFetch }
  );
  assert.deepEqual(result, {
    search_url: 'https://www.douban.com/search?cat=1002&q=Dead%20Man%E2%80%99s%20Wire',
  });
});
