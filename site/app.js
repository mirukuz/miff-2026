let films = [];
let bySlug = new Map();
let sortKey = 'imdb';

const $list = document.getElementById('film-list');

// —— 想看列表：只存 slug 数组在 localStorage，片名/链接渲染时从 films.json 现查 ——
const WATCHLIST_KEY = 'miff2026-watchlist';

function loadWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY)) ?? []); }
  catch { return new Set(); }
}
const watchlist = loadWatchlist();

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...watchlist]));
  updateFab();
}

function updateFab() {
  const fab = document.getElementById('fav-fab');
  fab.hidden = watchlist.size === 0;
  document.getElementById('fav-count').textContent = watchlist.size;
}

const ratingOf = (f, key) =>
  key === 'douban' ? f.douban?.rating ?? null :
  key === 'imdb' ? f.imdb?.rating ?? null :
  key === 'rt' ? f.rt?.critics_score ?? null : null;

function sortFilms(list) {
  const copy = [...list];
  if (sortKey === 'title') {
    copy.sort((a, b) => (a.title_zh ?? a.title_en).localeCompare(b.title_zh ?? b.title_en, 'zh'));
  } else {
    copy.sort((a, b) => {
      const ra = ratingOf(a, sortKey), rb = ratingOf(b, sortKey);
      if (ra == null && rb == null) return (a.title_en ?? '').localeCompare(b.title_en ?? '');
      if (ra == null) return 1;              // 无评分排最后
      if (rb == null) return -1;
      return rb - ra;
    });
  }
  return copy;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeUrl = (u) => /^https?:\/\//i.test(u ?? '') ? u : null;

function badge(cls, label, text, url) {
  const inner = `<span class="badge ${cls}">${label} ${text}</span>`;
  const safe = safeUrl(url);
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener">${inner}</a>` : inner;
}

// 只渲染有评分的 badge（抓不到评分的「暂无」pill 不显示）；若全都无则整行不渲染。
function badges(f, doubanUrl, imdbUrl, rtUrl) {
  const items = [];
  if (f.douban?.rating != null) items.push(badge('douban', '豆瓣', f.douban.rating.toFixed(1), doubanUrl));
  if (f.imdb?.rating != null) items.push(badge('imdb', 'IMDB', f.imdb.rating.toFixed(1), imdbUrl));
  if (f.rt?.critics_score != null) items.push(badge('rt', '🍅', `${f.rt.critics_score}%`, rtUrl));
  return items.length ? `<div class="badges">${items.join('\n        ')}</div>` : '';
}

// detail 内部 HTML（简介 + 外链）。首屏不渲染，展开时按需构建，避免一次性建 375 份简介 DOM。
function detailHtml(f) {
  const doubanUrl = safeUrl(f.douban?.url) ?? safeUrl(f.douban?.search_url);
  const miffUrl = safeUrl(f.miff_url);
  const imdbUrl = safeUrl(f.imdb?.url);
  const rtUrl = safeUrl(f.rt?.url) ?? safeUrl(f.rt?.search_url);
  const synopsis = (f.synopsis_zh ?? f.synopsis_en ?? '').split('\n\n')
    .map((p) => `<p>${esc(p)}</p>`).join('');
  return `${synopsis}
    <p class="links">
      ${miffUrl ? `<a href="${esc(miffUrl)}" target="_blank" rel="noopener">MIFF 官网页面 ↗</a>` : ''}
      ${doubanUrl ? `<a href="${esc(doubanUrl)}" target="_blank" rel="noopener">${safeUrl(f.douban?.url) ? '豆瓣条目' : '豆瓣搜索'} ↗</a>` : ''}
      ${imdbUrl ? `<a href="${esc(imdbUrl)}" target="_blank" rel="noopener">IMDB ↗</a>` : ''}
      ${rtUrl ? `<a href="${esc(rtUrl)}" target="_blank" rel="noopener">${safeUrl(f.rt?.url) ? '烂番茄条目' : '烂番茄搜索'} ↗</a>` : ''}
    </p>`;
}

function card(f) {
  const meta = [f.director, f.year, f.country, f.runtime ? `${f.runtime} 分钟` : null]
    .filter(Boolean).join(' · ');
  const doubanUrl = safeUrl(f.douban?.url) ?? safeUrl(f.douban?.search_url);
  const imdbUrl = safeUrl(f.imdb?.url);
  const rtUrl = safeUrl(f.rt?.url) ?? safeUrl(f.rt?.search_url);
  const posterHtml = f.poster
    ? `<img class="poster" src="${esc(f.poster)}" alt="${esc(f.title_zh ?? f.title_en)} 海报" loading="lazy">`
    : '<div class="poster poster-empty"></div>';
  const faved = watchlist.has(f.slug);
  return `<article class="card" data-slug="${esc(f.slug)}">
    ${posterHtml}
    <div class="card-body">
      <button class="fav-btn${faved ? ' faved' : ''}" aria-label="${faved ? '移出想看' : '加入想看'}" aria-pressed="${faved}">${faved ? '♥' : '♡'}</button>
      <h2>${esc(f.title_zh ?? f.title_en)}</h2>
      <p class="title-en">${esc(f.title_en)}</p>
      ${badges(f, doubanUrl, imdbUrl, rtUrl)}
      ${f.highlight_zh ? `<p class="highlight">💡 ${esc(f.highlight_zh)}</p>` : ''}
      <p class="meta"><span>${esc(meta)}</span><span class="chevron" aria-hidden="true">⌄</span></p>
      <div class="detail" hidden></div>
    </div>
  </article>`;
}

function render() {
  $list.innerHTML = sortFilms(films).map(card).join('');
}

document.getElementById('sort-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn) return;
  sortKey = btn.dataset.sort;
  document.querySelectorAll('.sort-bar button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

function toggleFav(slug, btn) {
  const faved = !watchlist.has(slug);
  faved ? watchlist.add(slug) : watchlist.delete(slug);
  saveWatchlist();
  btn.classList.toggle('faved', faved);
  btn.textContent = faved ? '♥' : '♡';
  btn.setAttribute('aria-label', faved ? '移出想看' : '加入想看');
  btn.setAttribute('aria-pressed', faved);
}

$list.addEventListener('click', (e) => {
  const favBtn = e.target.closest('.fav-btn');
  if (favBtn) {                              // 点心形只切换收藏，不展开卡片
    toggleFav(favBtn.closest('.card').dataset.slug, favBtn);
    return;
  }
  if (e.target.closest('a')) return;         // 点外链不触发展开
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const d = cardEl.querySelector('.detail');
  if (!d.dataset.filled) {                    // 首次展开才构建简介 DOM
    const f = bySlug.get(cardEl.dataset.slug);
    if (f) d.innerHTML = detailHtml(f);
    d.dataset.filled = '1';
  }
  d.hidden = !d.hidden;
});

// —— 想看弹窗 ——
const $dialog = document.getElementById('fav-dialog');

function favFilms() {
  return [...watchlist].map((slug) => bySlug.get(slug)).filter(Boolean);
}

function renderDialog() {
  const items = favFilms().map((f) => `<li data-slug="${esc(f.slug)}">
    <div class="fav-item-text">
      <strong>${esc(f.title_zh ?? f.title_en)}</strong>
      <span class="fav-item-en">${esc(f.title_en)}</span>
      ${safeUrl(f.miff_url) ? `<a href="${esc(f.miff_url)}" target="_blank" rel="noopener">MIFF ↗</a>` : ''}
    </div>
    <button class="fav-remove" aria-label="移出想看">✕</button>
  </li>`);
  document.getElementById('fav-items').innerHTML =
    items.join('') || '<li class="fav-empty">还没有收藏，点卡片上的 ♡ 加入想看</li>';
}

document.getElementById('fav-fab').addEventListener('click', () => {
  renderDialog();
  $dialog.showModal();
});

document.getElementById('fav-close').addEventListener('click', () => $dialog.close());
$dialog.addEventListener('click', (e) => {   // 点弹窗外的遮罩关闭
  if (e.target === $dialog) $dialog.close();
});

document.getElementById('fav-items').addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-remove');
  if (!btn) return;
  const slug = btn.closest('li').dataset.slug;
  watchlist.delete(slug);
  saveWatchlist();
  renderDialog();
  const cardBtn = $list.querySelector(`.card[data-slug="${CSS.escape(slug)}"] .fav-btn`);
  if (cardBtn) {
    cardBtn.classList.remove('faved');
    cardBtn.textContent = '♡';
    cardBtn.setAttribute('aria-pressed', 'false');
  }
  if (watchlist.size === 0) $dialog.close();
});

document.getElementById('fav-copy').addEventListener('click', async (e) => {
  const text = favFilms()
    .map((f) => `${f.title_zh ?? f.title_en}（${f.title_en}）\n${f.miff_url ?? ''}`.trim())
    .join('\n\n');
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制 ✓';
  } catch {
    btn.textContent = '复制失败';
  }
  setTimeout(() => { btn.textContent = '复制片单'; }, 1500);
});

fetch('films.json')
  .then((r) => r.json())
  .then((data) => {
    films = data;
    bySlug = new Map(data.map((f) => [f.slug, f]));
    document.getElementById('notice').textContent = `共 ${films.length} 部影片`;
    render();
    updateFab();
  })
  .catch(() => {
    $list.innerHTML = '<p class="error">片单加载失败，请刷新重试。</p>';
  });
