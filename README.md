# MIFF 2026 中文导览

墨尔本国际电影节非官方中文片单：豆瓣/IMDB 评分 + 中文简介 + 一句话看点。

## 更新数据（7月9日全量节目单发布后执行）

```bash
npm install
npm run build        # scrape → imdb → douban → translate，产出 site/films.json
npm test
```

- 已翻译影片按内容哈希缓存于 `data/translations/`，只翻新片；全量数百部首次翻译为串行 claude 调用，预计 1–2 小时
- 列表页为分页版（`/program/films?page=N`），`scrape-miff.mjs` 沿 `rel="next"` 抓完所有页并按 slug 去重；
  快速验证：`node scripts/scrape-miff.mjs --list-only`（只抓列表），`--limit=5`（抽样 5 部详情，写 `data/miff-raw.sample.json` 不动基线）
- 单跑某步：`npm run build -- --step=douban`
- 豆瓣被限流：未匹配结果不会写入缓存，稍后直接重跑 `npm run build -- --step=douban,translate` 即可续跑
- 抓取失败清单：`data/errors.json`
- 若官网改版导致完整性校验退出：改 `scripts/lib/parse-miff.mjs` 的选择器，
  用 `tests/fixtures/` 重抓 fixture 后跑 `npm test`

## 部署

`site/` 即完整站点。Cloudflare Pages：build command 留空，output directory 填 `site`。

## 7月16日开票后（暂未实现）

各片 `item_hash` 非空后，可调 `https://tix.miff.com.au/api/v1/Items/DatesCached?itemHash=...`
拿排片写入 `sessions` 字段，前端已预留该字段。
