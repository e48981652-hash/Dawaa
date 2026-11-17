'use strict';

// صفحة الضيف: يرى الدعوة ويرد عليها، وبعد وصول التذكير يؤكد حضوره مرة ثانية.
(() => {
  const root = document.getElementById('root');
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

  let data = null;
  let view = 'choose'; // choose | companions | done
  let companions = 0;
  let busy = false;
  let fresh = false; // يعرض حركة علامة الصح عند الرد للتو فقط
  let error = '';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('تعذّر الاتصال، تأكد من الإنترنت وحاول مرة ثانية');
    }
    let json = null;
    try { json = await res.json(); } catch { /* بدون JSON */ }
    if (!res.ok) throw new Error((json && json.error) || 'صار خطأ، حاول مرة ثانية');
    return json;
  }

  const companionsText = (n) => (n === 1 ? 'مرافق واحد' : n === 2 ? 'مرافقان' : `${n} مرافقين`);

  function checkMark(animate) {
    const wrap = document.createElement('div');
    // نص ثابت موثوق (لا يدخل فيه أي مدخل من المستخدم)
    wrap.innerHTML =
      `<svg class="check${animate ? ' anim' : ''}" viewBox="0 0 76 76" aria-hidden="true">` +
      '<circle cx="38" cy="38" r="28"/><path d="M26 39l8 8 16-17"/></svg>';
    return wrap.firstChild;
  }

  function downloadCalendar() {
    const e = data.event;
    const start = new Date(e.startsAt);
    const end = new Date(start.getTime() + 4 * 3600 * 1000);
    const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hayyak//AR', 'BEGIN:VEVENT',
      `UID:${token}@hayyak`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(e.title)}`, `LOCATION:${esc(e.venue)}`, `DESCRIPTION:${esc(e.notes)}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = h('a', { href: url, download: 'invitation.ics' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function send(status, count = 0) {
    busy = true;
    error = '';
    render();
    try {
      const r = await call('POST', `/api/invite/${encodeURIComponent(token)}/respond`, { status, companions: count });
      data.guest.status = r.guest.status;
      data.guest.companions = r.guest.companions;
      data.mode = 'invite';
      view = 'done';
      fresh = true;
    } catch (ex) {
      error = ex.message;
    }
    busy = false;
    render();
  }

  function chooseAccept() {
    const e = data.event;
    if (e.allowCompanions && e.maxCompanions > 0) {
      companions = Math.min(data.guest.companions, e.maxCompanions);
      view = 'companions';
      error = '';
      render();
    } else {
      send('accepted', 0);
    }
  }

  const errorLine = () => h('p', { class: 'form-error', role: 'alert' }, error);

  function chooseView() {
    const g = data.guest;
    const reminder = data.mode === 'reminder';
    const previous = { accepted: 'ستحضر', maybe: 'ربما', declined: 'اعتذرت' }[g.status];
    return h('section', { class: 'reply' },
      h('h2', null, reminder ? 'نأمل تأكيد حضورك مرة ثانية' : 'هل تتشرف بحضورك؟'),
      h('p', { class: 'sub' },
        reminder
          ? (previous ? `ردّك السابق: ${previous}. تأكيدك يساعد صاحب الدعوة في تجهيز المكان.` : 'تأكيدك يساعد صاحب الدعوة في تجهيز المكان.')
          : 'يسعدنا معرفة ردّك.'),
      h('div', { class: 'choices' },
        h('button', { class: 'btn saffron', type: 'button', disabled: busy, onclick: chooseAccept },
          reminder ? 'أؤكد حضوري' : 'أحضر بإذن الله'),
        // الدعوة الأولى: حضور ← ربما ← اعتذار. التذكير: حضور ← اعتذار، و«لست متأكداً» رابط ثانوي.
        reminder
          ? [
            h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: () => send('declined') }, 'أعتذر عن الحضور'),
            h('button', { class: 'link-btn', type: 'button', disabled: busy, onclick: () => send('maybe') }, 'لست متأكداً بعد'),
          ]
          : [
            h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: () => send('maybe') }, 'ربما'),
            h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: () => send('declined') }, 'أعتذر'),
          ]),
      error && errorLine());
  }

  function companionsView() {
    const max = data.event.maxCompanions;
    const out = h('output', { 'aria-live': 'polite' }, String(companions));
    const minus = h('button', {
      type: 'button', 'aria-label': 'إنقاص عدد المرافقين', disabled: companions <= 0,
      onclick: () => { companions -= 1; render(); },
    }, '−');
    const plus = h('button', {
      type: 'button', 'aria-label': 'زيادة عدد المرافقين', disabled: companions >= max,
      onclick: () => { companions += 1; render(); },
    }, '+');
    return h('section', { class: 'reply' },
      h('h2', null, 'كم عدد مرافقيك؟'),
      h('p', { class: 'sub' }, `يمكنك إحضار حتى ${max}. اترك الرقم صفراً إن كنت ستحضر وحدك.`),
      h('div', { class: 'stepper' }, plus, out, minus),
      h('div', { class: 'choices' },
        h('button', { class: 'btn saffron', type: 'button', disabled: busy, onclick: () => send('accepted', companions) }, 'تأكيد الحضور'),
        h('button', { class: 'btn ghost', type: 'button', disabled: busy, onclick: () => { view = 'choose'; render(); } }, 'رجوع')),
      error && errorLine());
  }

  function doneView() {
    const g = data.guest;
    const copy = {
      accepted: ['تم تأكيد حضورك', g.companions > 0 ? `ننتظرك بإذن الله، ومعك ${companionsText(g.companions)}.` : 'ننتظرك بإذن الله.'],
      maybe: ['سجّلنا ردّك: ربما', 'يمكنك تغيير ردّك في أي وقت قبل المناسبة.'],
      declined: ['شكراً لإبلاغنا', 'نقدّر ردّك ويؤسفنا غيابك. يمكنك تغيير ردّك قبل المناسبة.'],
    }[g.status];
    const max = data.event.maxCompanions;
    const canEditCompanions = g.status === 'accepted' && !data.closed && data.event.allowCompanions && max > 0;
    if (canEditCompanions) companions = Math.min(Math.max(0, companions), max);
    return h('section', { class: 'reply done' },
      g.status === 'accepted' && checkMark(fresh),
      h('h2', null, copy[0]),
      h('p', { class: 'sub' }, copy[1]),
      g.status === 'accepted' && data.qrUrl && h('figure', { class: 'my-qr' },
        h('img', { src: new URL(data.qrUrl, location.href).pathname, alt: 'رمز QR الخاص بدعوتك', width: '168', height: '168' }),
        h('figcaption', null, 'رمزك الخاص، أبرزه عند الدخول')),
      canEditCompanions && h('div', { class: 'companion-edit' },
        h('p', { class: 'sub' }, `عدد المرافقين معك الآن: ${companionsText(g.companions)}`),
        h('div', { class: 'stepper' },
          h('button', {
            type: 'button', 'aria-label': 'زيادة عدد المرافقين', disabled: busy || companions >= max,
            onclick: () => { companions += 1; render(); },
          }, '+'),
          h('output', { 'aria-live': 'polite' }, String(companions)),
          h('button', {
            type: 'button', 'aria-label': 'تقليل عدد المرافقين', disabled: busy || companions <= 0,
            onclick: () => { companions -= 1; render(); },
          }, '-')),
        h('button', {
          class: 'btn saffron', type: 'button', disabled: busy || companions === g.companions,
          onclick: () => send('accepted', companions),
        }, 'حفظ عدد المرافقين')),
      h('div', { class: 'choices' },
        g.status === 'accepted' && h('button', { class: 'btn ghost', type: 'button', onclick: downloadCalendar }, 'أضف إلى التقويم'),
        !data.closed && h('button', {
          class: 'link-btn', type: 'button', onclick: () => { view = 'choose'; fresh = false; error = ''; render(); },
        }, 'تغيير ردّي')));
  }

  function replySection() {
    if (data.closed) {
      return h('p', { class: 'closed-note' }, 'انتهت هذه المناسبة. شكراً لك.');
    }
    if (view === 'companions') return companionsView();
    if (view === 'done') return doneView();
    return chooseView();
  }

  function render() {
    const e = data.event;
    root.replaceChildren(...[
      h('p', { class: 'hello' }, `أهلاً ${data.guest.name}`),
      e.hostLine && h('p', { class: 'from' }, 'دعوة من ', h('b', null, e.hostLine)),
      h('h1', { class: 'title' }, e.title),
      h('div', { class: 'divider', 'aria-hidden': 'true' }),
      h('p', { class: 'day' }, `${e.display.weekday} ${e.display.gregorian}`),
      h('p', { class: 'hijri' }, e.display.hijri),
      h('p', { class: 'time' }, `الساعة ${e.display.time}`),
      h('p', { class: 'place' }, e.venue),
      e.mapUrl && h('p', { class: 'map-link' },
        h('a', { class: 'btn ghost small', href: e.mapUrl, target: '_blank', rel: 'noopener noreferrer' }, 'فتح الموقع في الخرائط')),
      e.notes && h('p', { class: 'note' }, e.notes),
      h('div', { class: 'divider', 'aria-hidden': 'true' }),
      replySection(),
    ].filter(Boolean));
  }

  function renderProblem(message) {
    root.replaceChildren(h('div', { class: 'error-box' },
      h('h1', null, 'تعذّر عرض الدعوة'),
      h('p', { class: 'muted' }, message)));
  }

  (async () => {
    try {
      data = await call('GET', `/api/invite/${encodeURIComponent(token)}`);
    } catch (ex) {
      renderProblem(ex.message);
      return;
    }
    document.title = data.event.title;
    document.body.dataset.theme = data.event.template || 'najd';
    const themeColor = getComputedStyle(document.body).getPropertyValue('--t-page').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && themeColor) meta.setAttribute('content', themeColor);
    companions = Math.max(0, Number(data.guest.companions) || 0);
    view = data.mode === 'reminder' || data.guest.status === 'pending' ? 'choose' : 'done';
    render();
  })();
})();
