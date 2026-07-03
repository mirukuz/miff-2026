const STEPS = {
  scrape: async () => (await import('./scrape-miff.mjs')).scrape(),
  imdb: async () => (await import('./enrich-imdb.mjs')).enrich(),
  douban: async () => (await import('./enrich-douban.mjs')).enrich(),
  translate: async () => (await import('./translate.mjs')).translate(),
};

const arg = process.argv.find((a) => a.startsWith('--step='));
const wanted = arg ? arg.slice('--step='.length).split(',') : Object.keys(STEPS);

for (const name of wanted) {
  if (!STEPS[name]) {
    console.error(`未知步骤 ${name}；可选：${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }
  console.log(`\n=== ${name} ===`);
  await STEPS[name]();
}
