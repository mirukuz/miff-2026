export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const lastHit = new Map(); // 按 host 限速

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// blockedUrlPattern: 命中最终 URL（跟随重定向后）即判定为被反爬（豆瓣限流是 302 到
// sec.douban.com 验证码页并返回 200，不是 403，必须按最终 URL 识别）
export async function politeFetch(url, { minDelayMs = 1100, retries = 3, headers = {}, blockedUrlPattern = null } = {}) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) ?? 0) + minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' });
      if (res.status === 403 || res.status === 429 || (blockedUrlPattern && blockedUrlPattern.test(res.url))) {
        const err = new Error(`blocked (HTTP ${res.status}, final URL ${res.url}) for ${url}`);
        err.blocked = true;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (e.blocked || attempt >= retries) throw e;
      await sleep(2000 * attempt);
    }
  }
}
