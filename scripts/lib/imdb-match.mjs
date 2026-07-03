export function normalizeTitle(s) {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // 去变音符（勿写成字面组合字符，格式化工具会静默破坏）
    .toLowerCase()
    .replace(/[’'"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TYPE_SCORE = { movie: 3, tvMovie: 2, tvMiniSeries: 2, tvSeries: 2, short: 1 };

export function pickImdbMatch(film, candidates) {
  if (!film.year) return null;
  const eligible = candidates.filter(
    (c) => c.startYear && Math.abs(c.startYear - film.year) <= 1
  );
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    (Math.abs(a.startYear - film.year) - Math.abs(b.startYear - film.year)) ||
    ((TYPE_SCORE[b.titleType] ?? 0) - (TYPE_SCORE[a.titleType] ?? 0)) ||
    ((b.votes ?? 0) - (a.votes ?? 0))
  );
  return eligible[0];
}
