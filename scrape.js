'use strict';
// Собирает базу знаний с сайта: обходит страницы и сохраняет
//   knowledge/site.md       — тексты информационных страниц (контакты, доставка, оплата и т.п.)
//   knowledge/catalog.json  — товары: название, цена, размеры, ссылка (ассистент ищет по ним)
// Запуск на сервере:  node scrape.js            (по умолчанию https://praktik-home.ru/)
//                     node scrape.js https://другой-сайт.ru/ 800   (адрес и максимум страниц)

const fs = require('fs');
const path = require('path');

const START = process.argv[2] || 'https://praktik-home.ru/';
const MAX_PAGES = Number(process.argv[3] || 1500);
const OUT_DIR = path.join(__dirname, 'knowledge');
const ORIGIN = new URL(START);
const HOSTS = new Set([ORIGIN.hostname, ORIGIN.hostname.replace(/^www\./, ''), 'www.' + ORIGIN.hostname.replace(/^www\./, '')]);
const SITE_MD_LIMIT = 25000; // символов на все информационные страницы
const PAGE_LIMIT = 5000;

// Страницы, которые важнее всего для ответов (идут первыми).
const PRIORITY = /contact|kontakt|dostav|delivery|oplat|payment|garant|warrant|about|o-kompan|where|gde-kupit|faq|vopros|uslug|service|montazh|sborka|zamer|metal|partner|sotrud|vozvrat|return|proekt|project/i;
const SKIP_PATH = /\/(news|ideas|blog|articles|stati|search|personal|auth|login|basket|cart|order|compare|bitrix|upload|local|ajax)\b|\.(jpe?g|png|gif|webp|svg|pdf|docx?|xlsx?|zip|rar|mp4|css|js|xml|ico)$/i;

const cookies = new Map();

function cookieHeader() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function get(url) {
  // Редиректы обрабатываем сами, чтобы сохранять cookie (Битрикс иначе может зациклиться).
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; site-chat-knowledge/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Cookie: cookieHeader(),
      },
      signal: AbortSignal.timeout(20000),
    });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const m = c.match(/^([^=;]+)=([^;]*)/);
      if (m) cookies.set(m[1].trim(), m[2]);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), url);
      url = next.href;
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!/html/i.test(res.headers.get('content-type') || '')) return null;
    return { url, html: await res.text() };
  }
  throw new Error('слишком много редиректов');
}

function decode(s) {
  return s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function textOf(html) {
  return decode(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|header|footer|nav|form|select)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article|\/dt|\/dd)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/^\|\s*|\s*\|\s*$/g, '').trim())
    .filter((l) => l.length > 1);
}

function first(re, s) {
  const m = s.match(re);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function links(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try {
      u = new URL(decode(m[1]), base);
    } catch {
      continue;
    }
    if (!HOSTS.has(u.hostname) || !/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    // Из параметров оставляем только постраничную навигацию каталога.
    const page = [...u.searchParams].find(([k]) => /^PAGEN_\d+$/.test(k));
    u.search = page ? `?${page[0]}=${page[1]}` : '';
    if (SKIP_PATH.test(u.pathname)) continue;
    out.add(u.href);
  }
  return out;
}

function product(html, url, lines) {
  let name = '';
  let price = '';
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const items = [].concat(JSON.parse(m[1]));
      for (const it of items.flatMap((x) => (x['@graph'] ? x['@graph'] : [x]))) {
        if (/Product/i.test(it['@type'])) {
          name = name || it.name;
          const off = [].concat(it.offers || [])[0];
          if (off) price = price || off.price || off.lowPrice;
        }
      }
    } catch {}
  }
  const isProductPath = /\/products?\//.test(new URL(url).pathname);
  if (!name && !isProductPath) return null;
  name = name || first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).replace(/<[^>]+>/g, '');
  price = price || first(/itemprop=["']price["'][^>]*content=["']([\d.,\s]+)["']/i, html);
  if (!price) {
    const p = lines.join(' ').match(/(\d[\d\s]{1,9})\s?(₽|руб)/);
    if (p) price = p[1].replace(/\s/g, '');
  }
  if (!name || !price) return null;
  const all = lines.join('\n');
  const dims = (all.match(/\d{2,4}\s?[xх×]\s?\d{2,4}(\s?[xх×]\s?\d{2,4})?\s?мм/i) || [''])[0];
  const weight = (all.match(/\d+[.,]?\d*\s?кг/i) || [''])[0];
  const crumbs = first(/class=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]*?)<\/(ul|ol|div|nav)>/i, html)
    .replace(/<[^>]+>/g, ' / ').replace(/(\s*\/\s*)+/g, ' / ').replace(/^\s*\/|\/\s*$/g, '').trim();
  const desc = first(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i, html);
  return {
    name: String(name).trim(),
    price: Number(String(price).replace(/[^\d.]/g, '')) || String(price),
    dims,
    weight,
    category: crumbs.slice(0, 200),
    desc: desc.slice(0, 300),
    url,
  };
}

async function main() {
  const queue = [START];
  const key = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const seen = new Set(queue.map(key));
  const pages = [];
  const products = new Map();
  const lineCount = new Map();

  while (queue.length && pages.length + products.size < MAX_PAGES) {
    const batch = queue.splice(0, 4);
    await Promise.all(
      batch.map(async (url) => {
        let page;
        try {
          page = await get(url);
        } catch (e) {
          console.log('  ✗', url, e.message);
          return;
        }
        if (!page) return;
        const lines = textOf(page.html);
        for (const l of new Set(lines)) lineCount.set(l, (lineCount.get(l) || 0) + 1);
        const p = product(page.html, page.url, lines);
        if (p) products.set(key(p.url), p);
        else {
          const title = first(/<h1[^>]*>([\s\S]*?)<\/h1>/i, page.html).replace(/<[^>]+>/g, '') || first(/<title[^>]*>([\s\S]*?)<\/title>/i, page.html);
          pages.push({ url: page.url, title, lines });
        }
        for (const l of links(page.html, page.url)) {
          if (!seen.has(key(l))) {
            seen.add(key(l));
            queue.push(l);
          }
        }
        console.log(p ? '  🛒' : '  📄', page.url);
      })
    );
    await new Promise((r) => setTimeout(r, 300));
  }

  // Строки, которые повторяются на многих страницах (меню, подвал), считаем шаблоном.
  const total = pages.length + products.size;
  const boiler = (l) => total > 5 && lineCount.get(l) > Math.max(3, total * 0.3);

  const isListing = (p) => /\/catalog\//.test(new URL(p.url).pathname) || /PAGEN_/.test(p.url);
  const info = pages
    .filter((p) => !isListing(p))
    .sort((a, b) => (PRIORITY.test(b.url) ? 1 : 0) - (PRIORITY.test(a.url) ? 1 : 0) || a.url.length - b.url.length);

  let md = `# Сайт ${ORIGIN.hostname}: информационные страницы\n\n(собрано автоматически ${new Date().toLocaleDateString('ru-RU')} командой node scrape.js, не редактируйте этот файл вручную: он перезапишется. Свои дополнения пишите в отдельный файл в папке knowledge/)\n`;
  let used = 0;
  for (const p of info) {
    const body = p.lines.filter((l) => !boiler(l)).join('\n').slice(0, PAGE_LIMIT).trim();
    if (body.length < 80) continue;
    const block = `\n## ${p.title || p.url}\nСсылка: ${p.url}\n\n${body}\n`;
    if (used + block.length > SITE_MD_LIMIT) continue;
    md += block;
    used += block.length;
  }

  const categories = pages
    .filter((p) => /\/catalog\/[^/]+\/?$|\/catalog\/[^/]+\/[^/]+\/?$/.test(new URL(p.url).pathname) && !/PAGEN_/.test(p.url))
    .map((p) => ({ name: p.title, url: p.url }))
    .filter((c) => c.name);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'site.md'), md);
  fs.writeFileSync(path.join(OUT_DIR, 'catalog.json'), JSON.stringify({ updated: new Date().toISOString(), categories, products: [...products.values()] }, null, 1));
  console.log(`\nГотово: ${info.length} информационных страниц (${used} символов) → knowledge/site.md, ${products.size} товаров и ${categories.length} разделов → knowledge/catalog.json`);
  console.log('Перезапустите чат, чтобы он сразу подхватил изменения: systemctl restart site-chat (или подождите, он перечитает файлы сам).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
