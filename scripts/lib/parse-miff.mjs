import * as cheerio from 'cheerio';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// 信息行：span 之间以裸文本 "/" 分隔；字段可选、按模式识别。
// 返回 { director, year, runtime, countries, languages, premiere }
export function parseInfoLine($, container) {
  const segments = [];
  let current = [];
  container.contents().each((_, node) => {
    if (node.type === 'text') {
      if (node.data.includes('/')) {
        if (current.length) segments.push(current);
        current = [];
      }
    } else if (node.name === 'span') {
      const t = clean($(node).text());
      if (t) current.push(t);
    }
  });
  if (current.length) segments.push(current);

  const out = { director: null, year: null, runtime: null, countries: [], languages: [], premiere: null };
  const leftovers = [];
  for (const seg of segments) {
    const joined = seg.join(', ');
    if (/^Dir\./i.test(joined)) out.director = clean(joined.replace(/^Dir\.\s*/i, ''));
    else if (seg.length === 1 && /^\d{4}$/.test(seg[0])) out.year = Number(seg[0]);
    else if (seg.length === 1 && /^(\d+)\s*mins?$/i.test(seg[0])) out.runtime = Number(seg[0].match(/^(\d+)/)[1]);
    else if (/premiere/i.test(joined)) out.premiere = joined;
    else leftovers.push(seg);
  }
  // 剩余段按出现顺序：第一段是国家，第二段（列表页才有）是语言
  if (leftovers[0]) out.countries = leftovers[0];
  if (leftovers[1]) out.languages = leftovers[1];
  return out;
}

export function parseProgramPage(html) {
  const $ = cheerio.load(html);
  const films = [];
  $('div.film-card').each((_, el) => {
    const card = $(el);
    const href = card.find('h3 a').attr('href') ?? '';
    const m = href.match(/\/program\/film\/([^#?]+)/);
    if (!m) return;
    const info = parseInfoLine($, card.find('div.leading-tight').first());
    films.push({
      slug: m[1],
      genre: clean(card.find('span.tag').first().text()) || null,
      thumb: card.find('img').attr('src') || null,
      blurb: clean(card.find('div.line-clamp-4').text()) || null,
      director: info.director,
      year: info.year,
      runtime: info.runtime,
      countries: info.countries,
      languages: info.languages,
    });
  });
  return films;
}

export function parseFilmPage(html, slug) {
  const $ = cheerio.load(html);
  const info = parseInfoLine($, $('#film_details div.leading-tight').first());

  // 简介限定在 #film_details 内第一个 .prose（页首活动文案也有 .prose，不能全局选）
  const paragraphs = [];
  $('#film_details .prose').first().find('p').each((_, p) => {
    const t = clean($(p).text());
    if (t) paragraphs.push(t);
  });
  // 媒体评语：只把末尾连续的、以引号开头的段落摘出（简介正文中间合法地可含引号，不能误删）
  const quotes = [];
  while (paragraphs.length && /^[“"]/.test(paragraphs[paragraphs.length - 1])) {
    quotes.unshift(paragraphs.pop());
  }
  const pressQuote = quotes.length ? quotes.join('\n\n') : null;

  const credits = {};
  $('#film_details .creditblock h4.credit-heading').each((_, h) => {
    const role = clean($(h).text());
    const names = $(h).next('div').find('span')
      .map((_, s) => clean($(s).text())).get().filter(Boolean);
    if (role && names.length) credits[role] = names;
  });

  const hashMatch = html.match(/itemHash=([a-f0-9]+)/);
  return {
    slug,
    title_en: clean($('#film_title h1').first().text()) || null,
    director: info.director ?? (credits.Director ? credits.Director.join(', ') : null),
    year: info.year,
    runtime: info.runtime,
    countries: info.countries,
    premiere: info.premiere,
    synopsis_en: paragraphs.join('\n\n') || null,
    press_quote: pressQuote,
    credits,
    poster: $('meta[property="og:image"]').attr('content') || null,
    item_hash: hashMatch ? hashMatch[1] : null,
  };
}
