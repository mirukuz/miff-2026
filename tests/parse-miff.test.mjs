import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProgramPage, parseFilmPage, parseNextPageUrl, parseMaxPage } from '../scripts/lib/parse-miff.mjs';

const programHtml = readFileSync(new URL('./fixtures/program.html', import.meta.url), 'utf8');
const filmHtml = readFileSync(new URL('./fixtures/film-dead-mans-wire.html', import.meta.url), 'utf8');
const page1Html = readFileSync(new URL('./fixtures/films-page1.html', import.meta.url), 'utf8');
const page8Html = readFileSync(new URL('./fixtures/films-page8.html', import.meta.url), 'utf8');

test('parseProgramPage 提取全部影片卡片', () => {
  const films = parseProgramPage(programHtml);
  assert.ok(films.length >= 20, `期望 >=20 部，实际 ${films.length}`);
  for (const f of films) {
    assert.match(f.slug, /^[a-z0-9-]+$/, `slug 非法: ${f.slug}`);
    assert.ok(!f.slug.includes('#'), 'slug 不应包含 #top');
  }
});

test('parseProgramPage 卡片字段按模式解析', () => {
  const films = parseProgramPage(programHtml);
  const withYear = films.filter(f => f.year >= 1900 && f.year <= 2030);
  assert.ok(withYear.length / films.length > 0.8, '大多数卡片应解析出年份');
  const withRuntime = films.filter(f => Number.isInteger(f.runtime) && f.runtime > 0);
  assert.ok(withRuntime.length / films.length > 0.8, '大多数卡片应解析出时长');
  const withDirector = films.filter(f => f.director);
  assert.ok(withDirector.length / films.length > 0.8, '大多数卡片应解析出导演');
});

test('parseProgramPage 解析全量片单分页列表页（每页 50 卡）', () => {
  assert.equal(parseProgramPage(page1Html).length, 50);
  assert.equal(parseProgramPage(page8Html).length, 25);
});

test('parseNextPageUrl 提取下一页链接，末页与旧单页均返回 null', () => {
  assert.match(parseNextPageUrl(page1Html) ?? '', /\/program\/films\?page=2$/);
  assert.equal(parseNextPageUrl(page8Html), null);
  assert.equal(parseNextPageUrl(programHtml), null);
});

test('parseMaxPage 提取分页器最大页码，无分页器返回 1', () => {
  assert.equal(parseMaxPage(page1Html), 8);
  assert.equal(parseMaxPage(programHtml), 1);
});

test('parseFilmPage 解析详情页', () => {
  const film = parseFilmPage(filmHtml, 'dead-mans-wire');
  assert.equal(film.title_en, 'Dead Man’s Wire');
  assert.match(film.director, /Gus Van Sant/);        // 双空格已归一
  assert.equal(film.year, 2025);
  assert.equal(film.runtime, 104);
  assert.deepEqual(film.countries, ['USA']);
  assert.match(film.premiere ?? '', /Premiere/i);
  assert.ok(film.synopsis_en.length > 200, '简介应为多段正文');
  assert.match(film.press_quote ?? '', /^[“"]/, '末尾媒体评语应单独抽出');
  assert.ok(!film.synopsis_en.includes('Hollywood Reporter'), '媒体评语段不应混入简介');
  assert.ok(Array.isArray(film.credits.Director));
  assert.match(film.poster, /^https:\/\/miff\.com\.au\/storage\//);
  assert.equal(film.item_hash, null);                 // 开票前为空
});
