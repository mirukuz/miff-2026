import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { normalizeTitle, pickImdbMatch } from './lib/imdb-match.mjs';

const DATASETS = ['title.basics.tsv.gz', 'title.ratings.tsv.gz'];

async function ensureDatasets() {
  mkdirSync('data/cache', { recursive: true });
  for (const name of DATASETS) {
    const dest = `data/cache/${name}`;
    if (existsSync(dest)) continue;
    console.log(`下载 ${name}（约数百 MB，只需一次）...`);
    const res = await fetch(`https://datasets.imdbws.com/${name}`);
    if (!res.ok) throw new Error(`下载失败 ${name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  }
}

async function* tsvLines(path) {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = line.split('\t'); continue; }
    yield line.split('\t');
  }
}

export async function enrich() {
  await ensureDatasets();
  const raw = JSON.parse(readFileSync('data/miff-raw.json', 'utf8'));
  const wanted = new Map(); // normTitle -> [film,...]
  for (const f of raw.films) {
    const key = normalizeTitle(f.title_en);
    if (!key) continue;
    if (!wanted.has(key)) wanted.set(key, []);
    wanted.get(key).push(f);
  }

  // 第一遍：basics —— tconst(0) titleType(1) primaryTitle(2) originalTitle(3) ... startYear(5)
  const candidates = new Map(); // normTitle -> [{tconst,titleType,startYear,primaryTitle}]
  for await (const cols of tsvLines('data/cache/title.basics.tsv.gz')) {
    // 1100 万行的热循环，避免每行分配 Set
    const keyPrimary = normalizeTitle(cols[2]);
    const keyOriginal = cols[3] === cols[2] ? keyPrimary : normalizeTitle(cols[3]);
    for (const key of keyPrimary === keyOriginal ? [keyPrimary] : [keyPrimary, keyOriginal]) {
      if (!wanted.has(key)) continue;
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push({
        tconst: cols[0], titleType: cols[1], primaryTitle: cols[2],
        startYear: cols[5] === '\\N' ? null : Number(cols[5]),
      });
    }
  }

  // 第二遍：ratings —— tconst(0) averageRating(1) numVotes(2)
  const needed = new Set([...candidates.values()].flat().map((c) => c.tconst));
  const ratings = new Map();
  for await (const cols of tsvLines('data/cache/title.ratings.tsv.gz')) {
    if (needed.has(cols[0])) ratings.set(cols[0], { rating: Number(cols[1]), votes: Number(cols[2]) });
  }

  let matched = 0;
  const films = raw.films.map((f) => {
    const cands = (candidates.get(normalizeTitle(f.title_en)) ?? []).map((c) => ({ ...c, ...ratings.get(c.tconst) }));
    const best = pickImdbMatch(f, cands);
    if (best) matched++;
    return {
      ...f,
      imdb: best ? {
        id: best.tconst,
        rating: best.rating ?? null,
        votes: best.votes ?? null,
        url: `https://www.imdb.com/title/${best.tconst}/`,
      } : null,
    };
  });
  writeFileSync('data/enriched-imdb.json', JSON.stringify({ ...raw, films }, null, 2));
  console.log(`IMDB 匹配 ${matched}/${films.length}（电影节新片匹配不到属正常）`);
}

if (process.argv[1].endsWith('enrich-imdb.mjs')) await enrich();
