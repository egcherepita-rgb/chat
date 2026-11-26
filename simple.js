'use strict';
// Простой бот без нейросети (бесплатно): отвечает по ключевым словам из базы знаний
// и по сценарию собирает заявку: имя → контакт → город.

const fs = require('fs');
const path = require('path');
const ai = require('./ai');

const LEAD_RE = /расч[её]т|просч|посчита|проект|замер|дизайн|заказ|оформ|купить|перезвон|позвон|свяж|консульт|менеджер|оператор|человек|смет/i;
const GREETING_RE = /^(здравствуй|здрасьте|добр|привет|хай|hello|hi|день добрый|доброго)/i;
const THANKS_RE = /^(спасибо|благодар|ок|окей|хорошо|понял|ясно)/i;
const HUMAN_RE = /(живо(й|го)|настоящ).*(человек|оператор|менеджер)|позовите|соедин/i;
const PHONE_RE = /(\+?\d[\d\s()\-]{8,}\d)/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const TG_RE = /(^|\s)@[A-Za-z0-9_]{4,}|t\.me\/\w+/i;

// ---------- Разделы базы знаний для ответов ----------
// Берём «## Заголовок» из файлов knowledge/*.md, кроме site.md (там сырой текст сайта).
// Строка «Ключевые слова: …» внутри раздела помогает находить его точнее.

let cache = { key: '', sections: [] };
function sections() {
  let files = [];
  try {
    files = fs.readdirSync(ai.KNOWLEDGE_DIR).filter((f) => /\.md$/i.test(f) && f !== 'site.md').sort();
  } catch {
    return [];
  }
  const full = files.map((f) => path.join(ai.KNOWLEDGE_DIR, f));
  const key = full.map((f) => f + fs.statSync(f).mtimeMs).join('|');
  if (key === cache.key) return cache.sections;
  const list = [];
  for (const f of full) {
    for (const part of fs.readFileSync(f, 'utf8').split(/^## /m).slice(1)) {
      const [title, ...rest] = part.split('\n');
      let body = rest.join('\n').trim();
      let keywords = '';
      body = body.replace(/^Ключевые слова:(.*)$/im, (_, k) => ((keywords = k), '')).trim();
      if (!body) continue;
      list.push({ title: title.trim(), body, head: ai.stems(title + ' ' + keywords), all: ai.stems(body) });
    }
  }
  cache = { key, sections: list };
  return list;
}

const STOP = new Set(['здрав', 'добры', 'добро', 'спаси', 'пожал', 'можно', 'подск', 'скажи', 'хочу', 'хотел', 'нужно', 'нужен', 'нужна', 'какой', 'какая', 'какие', 'есть', 'что', 'как', 'для', 'вас', 'это', 'или', 'мне', 'где', 'когд', 'есть', 'ваши', 'ваша', 'ваш', 'можн', 'будет']);

function bestSection(text) {
  const q = [...ai.stems(text)].filter((w) => !STOP.has(w));
  if (!q.length) return null;
  let best = null;
  for (const s of sections()) {
    const score = q.reduce((n, w) => n + (s.head.has(w) ? 3 : 0) + (s.all.has(w) ? 1 : 0), 0);
    if (score >= 3 && (!best || score > best.score)) best = { s, score };
  }
  return best && best.s;
}

function trimBody(body) {
  if (body.length <= 700) return body;
  const cut = body.slice(0, 700);
  return cut.slice(0, Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. ') + 1)) + '\n…';
}

// ---------- Разбор контактов ----------

function findContact(text) {
  const phone = text.match(PHONE_RE);
  if (phone && phone[1].replace(/\D/g, '').length >= 10) return phone[1].trim();
  const email = text.match(EMAIL_RE);
  if (email) return email[0];
  const tg = text.match(TG_RE);
  if (tg) return tg[0].trim();
  return '';
}

function cleanAnswer(text) {
  return text
    .replace(/^(меня зовут|я|это|мой город|город|из города|я из|живу в|в)\s+/i, '')
    .replace(/[.!]+$/, '')
    .trim()
    .slice(0, 80);
}

// ---------- Ответ ----------

const SAY = {
  hello: 'Здравствуйте! Я виртуальный помощник «Практик HOME». Подскажу по товарам и ценам, а если нужен расчёт или проект, передам заявку менеджеру. Что вас интересует?',
  askName: 'С удовольствием подготовим расчёт! Как к вам обращаться?',
  askContact: (name) => `${name ? name + ', о' : 'О'}ставьте, пожалуйста, телефон (или Telegram, WhatsApp, e-mail), чтобы менеджер мог с вами связаться.\nОставляя контакты, вы соглашаетесь с политикой обработки персональных данных: https://praktik-home.ru/legal/policy/`,
  badContact: 'Не получилось распознать контакт. Напишите, пожалуйста, номер телефона, например +7 900 123-45-67, или e-mail.',
  askCity: 'И в каком вы городе?',
  done: (name) => `Спасибо${name ? ', ' + name : ''}! Заявку передал менеджеру, он свяжется с вами для расчёта. Если хотите, опишите, что нужно (гардеробная, шкаф, кладовая) и примерные размеры, это ускорит расчёт.`,
  unknown: 'Передал ваш вопрос менеджеру, он ответит здесь в рабочее время. Если удобнее, оставьте телефон, и мы перезвоним.',
  handoff: 'Передаю диалог менеджеру, он ответит здесь в ближайшее рабочее время.',
};

function reply(v) {
  const visitorMsgs = v.msgs.filter((m) => m.from === 'visitor');
  const text = (visitorMsgs[visitorMsgs.length - 1] || {}).text || '';
  if (v.flow && v.flow.step === 'more' && (/\?/.test(text) || bestSection(text) || LEAD_RE.test(text))) v.flow = null;
  const flow = v.flow;

  // Идёт сбор заявки.
  if (flow) {
    const contact = findContact(text);
    if (contact && !flow.contact) flow.contact = contact;
    if (flow.step === 'name' && !contact) flow.name = cleanAnswer(text);
    else if (flow.step === 'contact' && !flow.contact) {
      if (flow.retry) {
        // Не распознали дважды: сохраняем как есть, менеджер разберётся.
        flow.contact = text.slice(0, 100);
      } else {
        flow.retry = true;
        return { text: SAY.badContact };
      }
    } else if (flow.step === 'city' && !contact) flow.city = cleanAnswer(text);
    else if (flow.step === 'more') flow.request = (flow.request ? flow.request + '; ' : '') + text.slice(0, 300);

    if (!flow.name) return (flow.step = 'name'), { text: SAY.askName };
    if (!flow.contact) return (flow.step = 'contact'), { text: SAY.askContact(flow.name) };
    if (!flow.city) return (flow.step = 'city'), { text: SAY.askCity };
    if (flow.step === 'more') {
      // Уточнение после заявки: дублируем менеджеру, отвечаем коротко.
      v.flow = null;
      return { text: 'Спасибо, добавил к заявке!', lead: { name: flow.name, contact: flow.contact, city: flow.city, request: text.slice(0, 300), update: true } };
    }
    flow.step = 'more';
    return { text: SAY.done(flow.name), lead: { name: flow.name, contact: flow.contact, city: flow.city, request: flow.request } };
  }

  if (HUMAN_RE.test(text)) return { text: SAY.handoff, handoff: true };

  // Посетитель сам оставил контакт или хочет расчёт: начинаем сбор заявки.
  const contact = findContact(text);
  if ((LEAD_RE.test(text) && !v.lead) || (contact && !v.lead)) {
    v.flow = { step: 'name', name: '', contact, city: '', request: text.slice(0, 300) };
    if (contact) return (v.flow.step = 'name'), { text: 'Спасибо, контакт записал! Как к вам обращаться?' };
    const found = ai.productsFor(text, 3);
    const prices = found.length ? 'Ориентиры по ценам с сайта:\n' + found.map((p) => ai.productLine(p).replace(/^- /, '• ')).join('\n') + '\n\n' : '';
    return { text: prices + SAY.askName };
  }

  const section = bestSection(text);
  const products = ai.productsFor(text, 4);
  if (section || products.length) {
    let out = section ? trimBody(section.body) : '';
    if (products.length) out += (out ? '\n\n' : '') + 'Нашёл на сайте:\n' + products.map((p) => ai.productLine(p).replace(/^- /, '• ')).join('\n');
    out += '\n\nНужен расчёт под ваши размеры? Напишите «расчёт», и я передам заявку менеджеру.';
    return { text: out };
  }

  if (GREETING_RE.test(text) && text.length < 40) return { text: SAY.hello };
  if (THANKS_RE.test(text) && text.length < 30) return { text: 'Пожалуйста! Если появятся вопросы, пишите.' };

  // Не знаем ответа: говорим об этом один раз за 30 минут, дальше ждём менеджера.
  if (v.unknownAt && Date.now() - v.unknownAt < 30 * 60e3) return { text: '' };
  v.unknownAt = Date.now();
  return { text: SAY.unknown };
}

module.exports = { reply, findContact, sections };
