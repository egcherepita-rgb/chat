'use strict';
// Минимальный онлайн-чат для сайта: сообщения посетителей уходят в Telegram-группу
// (отдельная тема на каждого посетителя), ответы из темы возвращаются в виджет.
// Без внешних зависимостей, нужен Node.js 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnvFile(path.join(__dirname, '.env'));

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TG_API = process.env.TG_API || 'https://api.telegram.org';

if (!BOT_TOKEN || !GROUP_ID) {
  console.error('Укажите BOT_TOKEN и GROUP_ID в файле .env');
  process.exit(1);
}

const MAX_TEXT = 4000;
const POLL_TIMEOUT_MS = 25000;
const WIDGET_JS = fs.readFileSync(path.join(__dirname, 'public', 'widget.js'));

// ---------- Хранилище ----------

let db = { offset: 0, counter: 0, visitors: {}, topics: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  }, 300);
}

function getVisitor(id) {
  if (!db.visitors[id]) {
    db.visitors[id] = { n: ++db.counter, topicId: null, created: Date.now(), msgs: [] };
  }
  return db.visitors[id];
}

function addMessage(visitorId, msg) {
  const v = getVisitor(visitorId);
  msg.id = (v.msgs.length ? v.msgs[v.msgs.length - 1].id : 0) + 1;
  msg.ts = Date.now();
  v.msgs.push(msg);
  if (v.msgs.length > 500) v.msgs.splice(0, v.msgs.length - 500);
  save();
  wake(visitorId);
  return msg;
}

// ---------- Long polling для виджета ----------

const waiters = new Map(); // visitorId -> Set<fn>

function wake(visitorId) {
  const set = waiters.get(visitorId);
  if (!set) return;
  waiters.delete(visitorId);
  for (const fn of set) fn();
}

function messagesAfter(visitorId, after) {
  const v = db.visitors[visitorId];
  return v ? v.msgs.filter((m) => m.id > after) : [];
}

// ---------- Telegram ----------

async function tg(method, params) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`${method}: ${data.description}`);
    err.description = data.description || '';
    throw err;
  }
  return data.result;
}

async function ensureTopic(visitorId, page) {
  const v = getVisitor(visitorId);
  if (v.topicId) return v.topicId;
  const topic = await tg('createForumTopic', { chat_id: GROUP_ID, name: `Посетитель #${v.n}` });
  v.topicId = topic.message_thread_id;
  db.topics[v.topicId] = visitorId;
  save();
  const info = ['Новый посетитель на сайте'];
  if (page) info.push(`Страница: ${page}`);
  await tg('sendMessage', {
    chat_id: GROUP_ID,
    message_thread_id: v.topicId,
    text: info.join('\n'),
    link_preview_options: { is_disabled: true },
  });
  return v.topicId;
}

async function forwardToTelegram(visitorId, text, page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const topicId = await ensureTopic(visitorId, page);
    try {
      await tg('sendMessage', { chat_id: GROUP_ID, message_thread_id: topicId, text });
      return;
    } catch (e) {
      // Тему удалили в Telegram: создаём новую и пробуем ещё раз.
      if (/thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(e.description) && attempt === 0) {
        delete db.topics[topicId];
        getVisitor(visitorId).topicId = null;
        continue;
      }
      throw e;
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(url) {
  return /^(https?:|mailto:|tel:)/i.test(url) ? url : 'https://' + url;
}

// Текст Telegram с entities -> безопасный HTML (ссылки, жирный, курсив и т.п.)
function entitiesToHtml(text, entities) {
  if (!text) return '';
  const tags = {
    bold: ['<b>', '</b>'],
    italic: ['<i>', '</i>'],
    underline: ['<u>', '</u>'],
    strikethrough: ['<s>', '</s>'],
    code: ['<code>', '</code>'],
    pre: ['<pre>', '</pre>'],
    blockquote: ['<blockquote>', '</blockquote>'],
    expandable_blockquote: ['<blockquote>', '</blockquote>'],
  };
  const link = (href) => [`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`, '</a>'];
  const list = (entities || [])
    .map((e) => {
      const part = text.substr(e.offset, e.length);
      let t = tags[e.type];
      if (e.type === 'url') t = link(safeUrl(part));
      else if (e.type === 'text_link') t = link(safeUrl(e.url));
      else if (e.type === 'email') t = link('mailto:' + part);
      else if (e.type === 'phone_number') t = link('tel:' + part.replace(/[^\d+]/g, ''));
      return t ? { start: e.offset, end: e.offset + e.length, open: t[0], close: t[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let out = '';
  const stack = [];
  let next = 0;
  for (let i = 0; i <= text.length; i++) {
    while (stack.length && stack[stack.length - 1].end === i) out += stack.pop().close;
    while (next < list.length && list[next].start === i) {
      out += list[next].open;
      stack.push(list[next++]);
    }
    if (i < text.length) out += escapeHtml(text[i]);
  }
  while (stack.length) out += stack.pop().close;
  return out.replace(/\n/g, '<br>');
}

function operatorMessage(m) {
  const html = entitiesToHtml(m.text || m.caption || '', m.entities || m.caption_entities);
  let file = null;
  if (m.photo) {
    file = { id: m.photo[m.photo.length - 1].file_id, kind: 'image', name: 'photo.jpg' };
  } else {
    const f = m.document || m.video || m.audio || m.voice || m.animation || m.video_note;
    if (f) {
      const isImage = m.document && /^image\//.test(f.mime_type || '');
      file = { id: f.file_id, kind: isImage ? 'image' : 'file', name: f.file_name || 'файл', size: f.file_size };
    } else if (m.sticker && !m.sticker.is_animated && !m.sticker.is_video) {
      file = { id: m.sticker.file_id, kind: 'image', name: 'sticker.webp' };
    }
  }
  if (!html && !file) return null;
  return { from: 'op', html, file };
}

async function pollTelegram() {
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: db.offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of updates) {
        db.offset = u.update_id + 1;
        const m = u.message;
        if (!m || String(m.chat.id) !== String(GROUP_ID) || !m.message_thread_id) continue;
        if (m.from && m.from.is_bot) continue;
        const visitorId = db.topics[m.message_thread_id];
        if (!visitorId) continue;
        const msg = operatorMessage(m);
        if (msg) addMessage(visitorId, msg);
      }
      if (updates.length) save();
    } catch (e) {
      console.error('Telegram:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------- HTTP ----------

const VISITOR_RE = /^[A-Za-z0-9_-]{16,64}$/;
const rate = new Map(); // visitorId -> [timestamps]

function tooFast(visitorId) {
  const now = Date.now();
  const list = (rate.get(visitorId) || []).filter((t) => now - t < 60000);
  list.push(now);
  rate.set(visitorId, list);
  return list.length > 20;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/+/, '/');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p === '/widget.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(WIDGET_JS);
  }

  if (p === '/api/send' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'bad request' });
    }
    const visitor = String(body.visitor || '');
    const text = String(body.text || '').trim().slice(0, MAX_TEXT);
    const page = String(body.page || '').slice(0, 500);
    if (!VISITOR_RE.test(visitor) || !text) return send(res, 400, { error: 'bad request' });
    if (tooFast(visitor)) return send(res, 429, { error: 'too many messages' });
    const msg = addMessage(visitor, { from: 'visitor', text });
    try {
      await forwardToTelegram(visitor, text, page);
    } catch (e) {
      console.error('Не удалось отправить в Telegram:', e.message);
      return send(res, 502, { error: 'telegram', msg });
    }
    return send(res, 200, { msg });
  }

  if (p === '/api/poll' && req.method === 'GET') {
    const visitor = url.searchParams.get('visitor') || '';
    const after = Number(url.searchParams.get('after') || 0);
    if (!VISITOR_RE.test(visitor)) return send(res, 400, { error: 'bad request' });
    const ready = messagesAfter(visitor, after);
    if (ready.length || url.searchParams.get('wait') !== '1') return send(res, 200, { msgs: ready });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = waiters.get(visitor);
      if (set) set.delete(finish);
      send(res, 200, { msgs: messagesAfter(visitor, after) });
    };
    const timer = setTimeout(finish, POLL_TIMEOUT_MS);
    if (!waiters.has(visitor)) waiters.set(visitor, new Set());
    waiters.get(visitor).add(finish);
    req.on('close', () => {
      done = true;
      clearTimeout(timer);
      const set = waiters.get(visitor);
      if (set) set.delete(finish);
    });
    return;
  }

  // Файлы из Telegram отдаём через сервер, чтобы не раскрывать токен бота.
  if (p === '/api/file' && req.method === 'GET') {
    const visitor = url.searchParams.get('visitor') || '';
    const fileId = url.searchParams.get('id') || '';
    const v = VISITOR_RE.test(visitor) && db.visitors[visitor];
    const entry = v && v.msgs.find((m) => m.file && m.file.id === fileId);
    if (!entry) return send(res, 404, { error: 'not found' });
    try {
      const info = await tg('getFile', { file_id: fileId });
      const r = await fetch(`${TG_API}/file/bot${BOT_TOKEN}/${info.file_path}`);
      if (!r.ok) throw new Error('download ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const disposition = entry.file.kind === 'image' ? 'inline' : 'attachment';
      res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(entry.file.name)}`,
        'Cache-Control': 'private, max-age=86400',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      });
      return res.end(buf);
    } catch (e) {
      // Bot API отдаёт файлы до 20 МБ.
      console.error('Файл:', e.message);
      return send(res, 502, { error: 'file unavailable' });
    }
  }

  if (p === '/health') return send(res, 200, { ok: true });
  send(res, 404, { error: 'not found' });
}

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

http
  .createServer((req, res) =>
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    })
  )
  .listen(PORT, HOST, () => console.log(`Чат запущен на http://${HOST}:${PORT}`));

tg('deleteWebhook')
  .then(() => tg('getMe'))
  .then((me) => console.log(`Бот @${me.username} подключён, группа ${GROUP_ID}`))
  .catch((e) => console.error('Проверьте BOT_TOKEN:', e.message))
  .finally(pollTelegram);

