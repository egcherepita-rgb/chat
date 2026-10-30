(function () {
  'use strict';
  if (window.__siteChatLoaded) return;
  window.__siteChatLoaded = true;

  var script = document.currentScript;
  var BASE = script.src.replace(/\/widget\.js.*$/, '');
  var cfg = {
    title: script.getAttribute('data-title') || 'Онлайн-консультант',
    greeting: script.getAttribute('data-greeting') || 'Здравствуйте! Чем могу помочь?',
    color: script.getAttribute('data-color') || '#2b7de9',
    position: script.getAttribute('data-position') === 'left' ? 'left' : 'right',
  };

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem('sitechat_' + key);
      localStorage.setItem('sitechat_' + key, value);
    } catch (e) {}
    return null;
  }

  var visitor = store('visitor');
  if (!visitor || !/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) {
    var bytes = new Uint8Array(18);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    visitor = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store('visitor', visitor);
  }
  var lastId = 0;
  var seen = Number(store('seen') || 0);
  var started = store('started') === '1';
  var polling = false;
  var isOpen = false;

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + cfg.position + ':0;';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var side = cfg.position;

  root.innerHTML =
    '<style>' +
    ':host,*{box-sizing:border-box}' +
    '.btn{position:fixed;bottom:20px;' + side + ':20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:' + cfg.color + ';color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.btn:hover{transform:scale(1.08)}' +
    '.btn::before,.btn::after{content:"";position:absolute;inset:0;border-radius:50%;background:' + cfg.color + ';z-index:-1;animation:sc-pulse 2.4s ease-out infinite}' +
    '.btn::after{animation-delay:1.2s}' +
    '.btn.shake{animation:sc-shake .8s ease}' +
    '@keyframes sc-pulse{0%{transform:scale(1);opacity:.55}100%{transform:scale(1.9);opacity:0}}' +
    '@keyframes sc-shake{0%,100%{transform:rotate(0)}15%{transform:rotate(-14deg) scale(1.1)}30%{transform:rotate(12deg) scale(1.1)}45%{transform:rotate(-10deg)}60%{transform:rotate(8deg)}75%{transform:rotate(-4deg)}}' +
    '@keyframes sc-pop{0%{opacity:0;transform:translateY(16px) scale(.9)}70%{transform:translateY(-3px) scale(1.02)}100%{opacity:1;transform:none}}' +
    '@keyframes sc-dot{0%,100%{opacity:1}50%{opacity:.3}}' +
    '.btn svg{width:28px;height:28px;fill:currentColor}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e53935;color:#fff;font:600 12px/20px Arial,sans-serif;text-align:center;display:none}' +
    '.panel{position:fixed;bottom:92px;' + side + ':20px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;font:14px/1.4 Arial,Helvetica,sans-serif;color:#222}' +
    '.panel.open{display:flex}' +
    '.head{background:' + cfg.color + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:15px}' +
    '.close{background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px}' +
    '.list{flex:1;overflow-y:auto;padding:14px;background:#f4f6f8;display:flex;flex-direction:column;gap:8px}' +
    '.msg{max-width:82%;padding:8px 12px;border-radius:12px;word-wrap:break-word;overflow-wrap:anywhere;white-space:normal}' +
    '.op{align-self:flex-start;background:#fff;border:1px solid #e3e6ea;border-bottom-left-radius:4px}' +
    '.me{align-self:flex-end;background:' + cfg.color + ';color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}' +
    '.msg a{color:inherit;text-decoration:underline}' +
    '.msg img{display:block;max-width:100%;border-radius:8px;margin:2px 0;cursor:zoom-in}' +
    '.msg pre,.msg code{font-family:monospace;background:rgba(0,0,0,.06);border-radius:4px;padding:0 3px}' +
    '.msg blockquote{margin:0;padding-left:8px;border-left:3px solid #ccc}' +
    '.file{display:inline-block;padding:6px 10px;background:#eef3fb;border-radius:8px;text-decoration:none!important;margin:2px 0}' +
    '.err{align-self:center;color:#c62828;font-size:12px}' +
    '.form{display:flex;border-top:1px solid #e3e6ea;background:#fff}' +
    'textarea{flex:1;border:0;resize:none;padding:12px 14px;font:inherit;outline:none;height:48px;max-height:120px;color:#222;background:#fff}' +
    '.send{border:0;background:none;color:' + cfg.color + ';padding:0 14px;cursor:pointer;display:flex;align-items:center}' +
    '.send svg{width:24px;height:24px;fill:currentColor}' +
    '.teaser{position:fixed;bottom:96px;' + side + ':20px;width:280px;max-width:calc(100vw - 40px);background:linear-gradient(135deg,' + cfg.color + ',#7b4dff);color:#fff;padding:14px 34px 14px 16px;border-radius:16px;border-bottom-' + side + '-radius:4px;box-shadow:0 10px 30px rgba(43,125,233,.45);font:15px/1.4 Arial,Helvetica,sans-serif;cursor:pointer;display:none;animation:sc-pop .5s ease}' +
    '.teaser .who{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.9;margin-bottom:6px}' +
    '.teaser .who i{width:8px;height:8px;border-radius:50%;background:#4cff8a;box-shadow:0 0 6px #4cff8a;animation:sc-dot 1.5s infinite}' +
    '.teaser span{display:block;font-weight:600;font-size:16px}' +
    '.teaser u{display:inline-block;margin-top:10px;background:#fff;color:' + cfg.color + ';text-decoration:none;font-weight:600;font-size:13px;padding:6px 14px;border-radius:20px}' +
    '.teaser b{position:absolute;top:6px;right:10px;font-weight:400;font-size:18px;color:#fff;opacity:.8;cursor:pointer}' +
    '@media (max-width:480px){.panel{' + side + ':0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}}' +
    '</style>' +
    '<button class="btn" type="button" aria-label="Открыть чат">' +
    '<svg viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.4 1.3 4.6 3.4 6.1L4.5 21l4.2-2.3c1 .2 2.1.3 3.3.3 5.5 0 10-3.6 10-8s-4.5-8-10-8z"/></svg>' +
    '<span class="badge"></span></button>' +
    '<div class="teaser"><div class="who"><i></i>Консультант онлайн</div><span></span><u>Задать вопрос</u><b aria-label="Скрыть">&times;</b></div>' +
    '<div class="panel" role="dialog" aria-label="' + cfg.title + '">' +
    '<div class="head"><span class="title"></span><button class="close" type="button" aria-label="Закрыть">&times;</button></div>' +
    '<div class="list"></div>' +
    '<form class="form"><textarea placeholder="Напишите сообщение…" rows="1"></textarea>' +
    '<button class="send" type="submit" aria-label="Отправить"><svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg></button></form>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var btn = $('.btn'), badge = $('.badge'), panel = $('.panel'), list = $('.list');
  var form = $('.form'), input = $('textarea');
  var teaser = $('.teaser');
  $('.title').textContent = cfg.title;
  teaser.querySelector('span').textContent = cfg.greeting;

  function bubble(cls) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  }

  function fileUrl(f) {
    return BASE + '/api/file?visitor=' + visitor + '&id=' + encodeURIComponent(f.id);
  }

  var pending = []; // тексты, отправленные с этой страницы и ещё не пришедшие из poll

  function render(m) {
    if (m.id <= lastId) return;
    lastId = m.id;
    if (m.from === 'visitor') {
      // Сообщение уже показано при отправке: не дублируем.
      for (var i = 0; i < pending.length; i++) {
        if (pending[i] === m.text) {
          pending.splice(i, 1);
          return;
        }
      }
      bubble('me').textContent = m.text;
      return;
    }
    var el = bubble('op');
    if (m.file) {
      if (m.file.kind === 'image') {
        var img = document.createElement('img');
        img.src = fileUrl(m.file);
        img.alt = '';
        img.onload = function () { list.scrollTop = list.scrollHeight; };
        img.onclick = function () { window.open(img.src, '_blank'); };
        el.appendChild(img);
      } else {
        var a = document.createElement('a');
        a.className = 'file';
        a.href = fileUrl(m.file);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '📎 ' + m.file.name;
        el.appendChild(a);
      }
    }
    if (m.html) {
      var t = document.createElement('div');
      t.innerHTML = m.html; // HTML уже экранирован на сервере
      el.appendChild(t);
    }
  }

  function unread(msgs) {
    var count = 0;
    msgs.forEach(function (m) { if (m.from === 'op' && m.id > seen) count++; });
    return count;
  }

  var pendingUnread = 0;
  function handle(msgs) {
    msgs.forEach(render);
    if (isOpen) markSeen();
    else {
      pendingUnread += unread(msgs.filter(function (m) { return m.id > seen; }));
      badge.textContent = pendingUnread;
      badge.style.display = pendingUnread ? 'block' : 'none';
    }
  }

  function markSeen() {
    seen = lastId;
    store('seen', String(seen));
    pendingUnread = 0;
    badge.style.display = 'none';
  }

  function request(method, path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, BASE + path);
    xhr.timeout = 40000;
    if (body) xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      cb(xhr.status >= 200 && xhr.status < 300 ? null : xhr.status || 'error', data);
    };
    xhr.onerror = xhr.ontimeout = function () { cb('network', null); };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  function poll() {
    if (polling) return;
    polling = true;
    (function loop() {
      request('GET', '/api/poll?wait=1&visitor=' + visitor + '&after=' + lastId, null, function (err, data) {
        if (!err && data) handle(data.msgs);
        setTimeout(loop, err ? 5000 : 300);
      });
    })();
  }

  function sendMessage(text) {
    var el = bubble('me');
    el.textContent = text;
    pending.push(text);
    request('POST', '/api/send', { visitor: visitor, text: text, page: location.href }, function (err, data) {
      var msg = data && data.msg;
      if (msg && msg.id > lastId) {
        var idx = pending.indexOf(text);
        if (idx >= 0) pending.splice(idx, 1);
      }
      if (msg && msg.id > lastId) lastId = msg.id;
      if (err) {
        var e = document.createElement('div');
        e.className = 'err';
        e.textContent = err === 429 ? 'Слишком много сообщений, подождите минуту' : 'Сообщение не доставлено, попробуйте ещё раз';
        list.appendChild(e);
        list.scrollTop = list.scrollHeight;
      }
      if (!started) {
        started = true;
        store('started', '1');
      }
      poll();
    });
  }

  function toggle(open) {
    isOpen = open;
    teaser.style.display = 'none';
    panel.classList.toggle('open', open);
    if (open) {
      markSeen();
      list.scrollTop = list.scrollHeight;
      setTimeout(function () { input.focus(); }, 50);
    }
  }

  teaser.onclick = function (e) {
    if (e.target.tagName === 'B') {
      teaser.style.display = 'none';
      store('teaser', '1');
      if (!pendingUnread) badge.style.display = 'none';
    } else toggle(true);
  };
  btn.onclick = function () { toggle(!isOpen); };
  $('.close').onclick = function () { toggle(false); };
  form.onsubmit = function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendMessage(text);
  };
  input.onkeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.onsubmit(e);
    }
  };

  bubble('op').textContent = cfg.greeting;

  // Время от времени кнопка покачивается, чтобы привлечь внимание.
  setInterval(function () {
    if (isOpen) return;
    btn.classList.remove('shake');
    void btn.offsetWidth;
    btn.classList.add('shake');
  }, 9000);

  function mount() {
    document.body.appendChild(host);
    // Посетитель уже писал раньше: подгружаем историю и ждём ответов.
    // Приветствие всплывает рядом с кнопкой через несколько секунд (если его не закрывали).
    if (!started && store('teaser') !== '1') {
      setTimeout(function () {
        if (isOpen) return;
        teaser.style.display = 'block';
        badge.textContent = '1';
        badge.style.display = 'block';
      }, 4000);
    }
    if (started) {
      request('GET', '/api/poll?visitor=' + visitor + '&after=0', null, function (err, data) {
        if (!err && data) handle(data.msgs);
        poll();
      });
    }
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
