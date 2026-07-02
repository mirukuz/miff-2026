# MIFF 2026 中文导览网站 — 设计文档

日期：2026-07-02
需求来源：requirement.md

## 目标

为墨尔本国际电影节（MIFF 2026，https://miff.com.au/program）做一个中文导览网站，帮助中国观众决策看什么片：

- 每部电影附豆瓣和 IMDB 链接，首页显示两边评分
- 英文简介翻译成中文，并生成一句话看点
- 目前官网只有 27 部 "First Glance" 预告片单；**7月9日（周四）发布全量节目单**（预计数百部），流水线必须能重跑适配
- 7月16日开票后才有排片数据（Ferve 票务 API），本期只预留字段，不实现排片功能

## 调研结论（2026-07-02）

- MIFF 官网为服务端渲染（Laravel + Livewire），无公开 JSON API，无 JSON-LD；HTML 结构规整，直接解析 HTML 是可靠方案
- robots.txt 完全开放，无反爬迹象；页面有 LiteSpeed 缓存，建议限速
- 列表页：`/program` 中提取 `href="/program/film/{slug}"`；sitemap.xml 不可用
- 详情页 `https://miff.com.au/program/film/{slug}` 可解析：英文标题（og:title）、简介（og:description + 正文多段）、信息行（导演/年份/时长/国家/首映级别）、creditblock（导演、制片、主演等）、海报（og:image）
- 站内搜索用 Typesense 但凭据未暴露，不可用作抓取入口
- 排片走 `tix.miff.com.au/api/v1/Items/{DatesCached,TimesCached}`，需页面注入的 itemHash，目前为空

## 技术方案（方案 A：纯脚本流水线 + 纯静态单页）

部署形式：纯静态网站，托管到 Cloudflare Pages（或 Vercel/GitHub Pages）。无后端。

### 架构与数据流水线

四个独立 Node.js 脚本（无框架、无外部服务依赖），按顺序执行，每步产出中间 JSON，可单独重跑：

1. **`scripts/scrape-miff.mjs`**
   - 抓 `/program` 提取全部 film slug；逐个抓详情页，限速 ~1 req/s
   - 解析：英文标题、导演、年份、国家、时长、类型、英文简介（全段落）、海报 URL
   - 产出 `data/miff-raw.json`
2. **`scripts/enrich-imdb.mjs`**
   - 下载 IMDB 官方数据集（title.basics.tsv.gz + title.ratings.tsv.gz，本地缓存）
   - 按"标题 + 年份（±1）"归一化模糊匹配，写入 IMDB ID、评分、投票数
   - 产出 `data/enriched-imdb.json`
3. **`scripts/enrich-douban.mjs`**
   - 尽力而为：用豆瓣移动端 suggest/搜索接口按英文名+年份搜条目，限速抓评分
   - 失败或无条目：只保留豆瓣搜索链接（`https://www.douban.com/search?cat=1002&q=...`），不算错误
   - 产出 `data/enriched-douban.json`
4. **`scripts/translate.mjs`**
   - 调 `claude -p` 批量生成：中文片名、简介中文翻译、一句话看点
   - 按 slug 缓存至 `data/translations/{slug}.json`，重跑只处理新片/变更片
   - 合并全部数据，最终输出 `site/films.json`

`npm run build` 串联全部；支持 `--step=scrape|imdb|douban|translate` 单跑某步。

### 数据模型（site/films.json 单条）

```json
{
  "slug": "dead-mans-wire",
  "title_en": "Dead Man's Wire",
  "title_zh": "…",
  "director": "…",
  "year": 2025,
  "country": "…",
  "runtime": 105,
  "genres": ["Feature"],
  "synopsis_en": "…",
  "synopsis_zh": "…",
  "highlight_zh": "一句话看点",
  "poster": "https://miff.com.au/storage/…",
  "miff_url": "https://miff.com.au/program/film/dead-mans-wire",
  "imdb": { "id": "tt…", "rating": 7.2, "votes": 1234, "url": "…" },
  "douban": { "id": "…", "rating": 8.1, "url": "…", "search_url": "…" },
  "sessions": []
}
```

- 无匹配/无评分时 `rating: null`（豆瓣整个对象可只含 `search_url`）
- `sessions` 为 7月16日排片预留的空数组

### 前端（site/，纯静态）

- `index.html` + `app.js` + `style.css`，fetch `films.json` 客户端渲染
- 卡片流：海报、中文名/英文名、豆瓣评分徽章（绿）、IMDB 评分徽章（黄）、一句话看点
- 点击卡片展开：完整中文简介、导演/年份/国家/时长、MIFF/豆瓣/IMDB 外链
- 顶部排序切换：豆瓣评分 / IMDB 评分 / 片名；无评分排在有评分之后
- 无评分显示"暂无评分"+ 对应搜索链接
- 全中文界面，移动端优先响应式

### 错误处理与降级

- 单片抓取/解析失败不中断流水线，汇总记录 `data/errors.json`，结束时报告
- 防官网改版静默出错：抓取后做字段完整性校验（标题/简介缺失率超过 20% 即报错退出，不产出坏数据）
- 豆瓣匹配不到属正常情况，降级为搜索链接

### 7月9日全量更新的适配

- 重跑 `npm run build`：新片自动纳入，已翻译片走缓存
- 若列表页出现 Livewire 分页/筛选，只需改 `scrape-miff.mjs` 的 slug 枚举逻辑，下游不动
- 完整性校验兜底防止改版后静默产出残缺数据

## 验证方式（全部由实施方执行，不依赖用户手测）

1. 流水线对当前 27 部片实际跑通，抽查产出 JSON 字段完整性与评分匹配正确性
2. 本地 HTTP server 起 `site/`，Playwright 打开验证：渲染、三种排序、卡片展开、无评分降级显示、移动端视口截图

## 明确不做（YAGNI）

- 筛选器、搜索框（用户确认只要评分排序）
- 每部电影独立 URL 页面
- 排片时间表（7月16日后另行考虑）
- 任何后端/数据库/用户系统
