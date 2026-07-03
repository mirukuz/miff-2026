let films = [];
let sortKey = 'douban';

const $list = document.getElementById('film-list');

const ratingOf = (f, key) =>
  key === 'douban' ? f.douban?.rating ?? null :
  key === 'imdb' ? f.imdb?.rating ?? null : null;

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

function badge(cls, label, rating, url) {
  const text = rating != null ? rating.toFixed(1) : '暂无';
  const inner = `<span class="badge ${cls}${rating == null ? ' none' : ''}">${label} ${text}</span>`;
  const safe = safeUrl(url);
  return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener">${inner}</a>` : inner;
}

function card(f) {
  const meta = [f.director, f.year, f.country, f.runtime ? `${f.runtime} 分钟` : null]
    .filter(Boolean).join(' · ');
  const doubanUrl = safeUrl(f.douban?.url) ?? safeUrl(f.douban?.search_url);
  const miffUrl = safeUrl(f.miff_url);
  const imdbUrl = safeUrl(f.imdb?.url);
  const synopsis = (f.synopsis_zh ?? f.synopsis_en ?? '').split('\n\n')
    .map((p) => `<p>${esc(p)}</p>`).join('');
  const posterHtml = f.poster
    ? `<img class="poster" src="${esc(f.poster)}" alt="${esc(f.title_zh ?? f.title_en)} 海报" loading="lazy">`
    : '<div class="poster poster-empty"></div>';
  return `<article class="card" data-slug="${esc(f.slug)}">
    ${posterHtml}
    <div class="card-body">
      <h2>${esc(f.title_zh ?? f.title_en)}</h2>
      <p class="title-en">${esc(f.title_en)}</p>
      <div class="badges">
        ${badge('douban', '豆瓣', f.douban?.rating ?? null, doubanUrl)}
        ${badge('imdb', 'IMDB', f.imdb?.rating ?? null, imdbUrl)}
      </div>
      ${f.highlight_zh ? `<p class="highlight">💡 ${esc(f.highlight_zh)}</p>` : ''}
      <p class="meta">${esc(meta)}</p>
      <div class="detail" hidden>
        ${synopsis}
        <p class="links">
          ${miffUrl ? `<a href="${esc(miffUrl)}" target="_blank" rel="noopener">MIFF 官网页面 ↗</a>` : ''}
          ${doubanUrl ? `<a href="${esc(doubanUrl)}" target="_blank" rel="noopener">${safeUrl(f.douban?.url) ? '豆瓣条目' : '豆瓣搜索'} ↗</a>` : ''}
          ${imdbUrl ? `<a href="${esc(imdbUrl)}" target="_blank" rel="noopener">IMDB ↗</a>` : ''}
        </p>
      </div>
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

$list.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;         // 点外链不触发展开
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const d = cardEl.querySelector('.detail');
  d.hidden = !d.hidden;
});

fetch('films.json', { cache: 'no-cache' })
  .then((r) => r.json())
  .then((data) => {
    films = data;
    document.getElementById('notice').textContent = `共 ${films.length} 部影片`;
    render();
  })
  .catch(() => {
    $list.innerHTML = '<p class="error">片单加载失败，请刷新重试。</p>';
  });
