'use strict';

// ───────── ثوابت ─────────
const KIND_LABELS = {
  wedding: 'حفل زواج',
  engagement: 'خطوبة أو ملكة',
  newborn: 'استقبال مولود',
  graduation: 'حفل تخرج',
  other: 'مناسبة أخرى',
};
const STATUS_LABELS = { accepted: 'حاضر', declined: 'معتذر', maybe: 'ربما', pending: 'لم يرد' };

const state = { user: null, demoMode: false, channel: 'whatsapp', problems: [] };
let navId = 0;
let cleanup = null;
const appEl = document.getElementById('app');

// ───────── أدوات ─────────
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* التخزين غير متاح */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* التخزين غير متاح */ } },
};

/** ينشئ عنصراً. كل النصوص تُضاف كـ textContent فلا خطر من حقن HTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

function put(el, ...children) {
  el.replaceChildren(
    ...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''),
  );
}

function mount(node) {
  put(appEl, node);
  window.scrollTo(0, 0);
}

function toast(message, kind) {
  const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3800);
}

const toLatin = (s) =>
  String(s).replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = '٠١٢٣٤٥٦٧٨٩'.indexOf(ch);
    return String(i >= 0 ? i : '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch));
  });

const todayRiyadh = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

// ───────── معاينة الدعوة (للقوالب) ─────────
const PF = (cal, opts) => new Intl.DateTimeFormat(`ar-SA-u-ca-${cal}-nu-latn`, { timeZone: 'Asia/Riyadh', ...opts });
const PREVIEW_FMT = {
  weekday: PF('gregory', { weekday: 'long' }),
  greg: PF('gregory', { day: 'numeric', month: 'long', year: 'numeric' }),
  hijri: PF('islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }),
  time: PF('gregory', { hour: 'numeric', minute: '2-digit', hour12: true }),
};

function previewDisplay(date, time) {
  let d = new Date(`${date}T${time || '20:30'}:00+03:00`);
  if (!date || Number.isNaN(d.getTime())) d = new Date(Date.now() + 14 * 86400000); // تاريخ مثال قبل اختيار التاريخ
  return {
    weekday: PREVIEW_FMT.weekday.format(d), greg: PREVIEW_FMT.greg.format(d),
    hijri: PREVIEW_FMT.hijri.format(d), time: PREVIEW_FMT.time.format(d),
  };
}

/** نسخة شكلية من بطاقة الدعوة (نفس أصناف CSS الخاصة بصفحة الضيف)، تُلوَّن بالقالب الذي يرثه من العنصر الأب */
function inviteMock(v) {
  const d = previewDisplay(v.date, v.time);
  return h('div', { class: 'invite', 'aria-hidden': 'true' },
    h('div', { class: 'band' }),
    h('div', { class: 'invite-body' },
      h('p', { class: 'hello' }, 'أهلاً ضيفنا الكريم'),
      h('p', { class: 'from' }, 'دعوة من ', h('b', null, v.hostLine || 'صاحب الدعوة')),
      h('div', { class: 'title' }, v.title || 'اسم المناسبة'),
      h('div', { class: 'divider' }),
      h('p', { class: 'day' }, `${d.weekday} ${d.greg}`),
      h('p', { class: 'hijri' }, d.hijri),
      h('p', { class: 'time' }, `الساعة ${d.time}`),
      h('p', { class: 'place' }, v.venue || 'مكان المناسبة'),
      v.notes && h('p', { class: 'note' }, v.notes),
      h('div', { class: 'divider' }),
      h('div', { class: 'reply' },
        h('h2', null, 'هل تتشرف بحضورك؟'),
        h('div', { class: 'choices' },
          h('div', { class: 'btn saffron' }, 'أحضر بإذن الله'),
          h('div', { class: 'btn ghost' }, 'ربما'),
          h('div', { class: 'btn ghost' }, 'أعتذر')))));
}

const KIND_MSG = { invite: 'دعوة', reminder: 'تذكير', reply: 'رد تلقائي' };
// روابط الصور تُعرض من نفس الموقع الذي فتحت منه التطبيق (الرابط المخزّن قد يكون عنوان النشر)
const relUrl = (u) => { try { return new URL(u).pathname; } catch { return u; } };

// القالب المقترح تلقائياً لكل نوع مناسبة (إلى أن يختار المنظّم بنفسه)
// عبارة المناسبة الافتراضية لكل نوع (نفس القيم في السيرفر)
const OCCASION_DEFAULTS = {
  wedding: 'حفل زفاف', engagement: 'حفل خطوبة', newborn: 'حفل استقبال مولود', graduation: 'حفل تخرج', other: 'مناسبة',
};
const SUGGESTED_TEMPLATE = { wedding: 'najd', engagement: 'rose', newborn: 'baby', graduation: 'grad', other: 'pearl' };

function field(label, input, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 9);
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint && h('p', { class: 'hint' }, hint));
}

function errorBox(message) {
  return h('div', { class: 'empty' },
    h('h2', null, 'تعذّر عرض الصفحة'),
    h('p', null, message),
    h('a', { class: 'btn', href: '#/' }, 'العودة إلى مناسباتي'));
}

// ───────── الاتصال بالسيرفر ─────────
const api = {
  token: store.get('hayyak_token'),
  async call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('تعذّر الاتصال بالسيرفر، تأكد من الإنترنت وحاول مرة ثانية');
    }
    let data = null;
    try { data = await res.json(); } catch { /* بدون JSON */ }
    if (res.status === 401 && api.token && !url.startsWith('/api/auth/')) {
      signOut();
      throw new Error((data && data.error) || 'انتهت الجلسة، سجّل الدخول من جديد');
    }
    if (!res.ok) throw new Error((data && data.error) || 'صار خطأ، حاول مرة ثانية');
    return data;
  },
  get: (u) => api.call('GET', u),
  post: (u, b) => api.call('POST', u, b === undefined ? {} : b),
  put: (u, b) => api.call('PUT', u, b),
  del: (u) => api.call('DELETE', u),
};

function signOut() {
  api.token = null;
  state.user = null;
  store.del('hayyak_token');
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  else route();
}

async function logout() {
  try { await api.post('/api/auth/logout'); } catch { /* نخرج على أي حال */ }
  signOut();
}

// ───────── الهيكل ─────────
function shell(...content) {
  return h('div', null,
    h('header', { class: 'top' },
      h('div', { class: 'top-in' },
        h('a', { class: 'brand', href: '#/' }, 'حيّاك'),
        state.user && h('div', { class: 'top-user' },
          h('span', { class: 'user' }, state.user.name),
          h('button', { class: 'link-btn light', type: 'button', onclick: logout }, 'خروج'))),
      h('div', { class: 'band', 'aria-hidden': 'true' })),
    state.demoMode && h('div', { class: 'demo', role: 'note' },
      'وضع تجريبي: الرسائل لا تُرسل فعلياً، وتظهر في «سجل الرسائل» داخل كل مناسبة.'),
    state.problems.length > 0 && h('div', { class: 'demo warn', role: 'alert' },
      `واتساب غير جاهز للإرسال الفعلي. ينقص في ملف .env: ${state.problems.join('، ')}`),
    h('main', { class: 'wrap' }, content));
}

function openDialog(title, body) {
  const dlg = h('dialog', { class: 'dlg', 'aria-label': title },
    h('div', { class: 'dlg-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'إغلاق', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'dlg-body' }, body));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ───────── اختيار الدولة (الأرقام من أي دولة) ─────────
const COUNTRIES = [
  ['966', 'السعودية'], ['20', 'مصر'], ['971', 'الإمارات'], ['965', 'الكويت'], ['974', 'قطر'], ['973', 'البحرين'],
  ['968', 'عُمان'], ['962', 'الأردن'], ['964', 'العراق'], ['961', 'لبنان'], ['963', 'سوريا'], ['967', 'اليمن'],
  ['970', 'فلسطين'], ['249', 'السودان'], ['218', 'ليبيا'], ['216', 'تونس'], ['213', 'الجزائر'], ['212', 'المغرب'],
  ['90', 'تركيا'], ['92', 'باكستان'], ['91', 'الهند'], ['880', 'بنغلاديش'], ['63', 'الفلبين'], ['62', 'إندونيسيا'],
  ['44', 'بريطانيا'], ['1', 'أمريكا وكندا'], ['49', 'ألمانيا'], ['33', 'فرنسا'], ['39', 'إيطاليا'], ['34', 'إسبانيا'],
];

/** قائمة اختيار الدولة؛ تتذكر آخر اختيار. الخيار الأخير: رقم دولي يُكتب كاملاً مع + */
function countrySelect() {
  let saved = '966';
  const v = store.get('hayyak_cc');
  if (v !== null && (v === '' || COUNTRIES.some(([c]) => c === v))) saved = v;
  const sel = h('select', { class: 'ltr-select', 'aria-label': 'الدولة' },
    COUNTRIES.map(([c, n]) => h('option', { value: c, selected: c === saved }, `${n} (+${c})`)),
    h('option', { value: '', selected: saved === '' }, 'دولة أخرى (اكتب الرقم كاملاً مع +)'));
  sel.addEventListener('change', () => store.set('hayyak_cc', sel.value));
  return sel;
}

// ───────── الدخول والتسجيل ─────────
function viewAuth(mode = 'login') {
  const isReg = mode === 'register';
  const err = h('p', { class: 'form-error', role: 'alert' });
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: '60' });
  const phone = h('input', {
    type: 'tel', class: 'ltr', inputmode: 'tel', autocomplete: 'username', placeholder: 'رقم الجوال',
  });
  const country = countrySelect();
  const password = h('input', {
    type: 'password', autocomplete: isReg ? 'new-password' : 'current-password',
  });
  const submit = h('button', { class: 'btn saffron block', type: 'submit' }, isReg ? 'إنشاء الحساب' : 'دخول');

  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const body = { phone: phone.value, country: country.value, password: password.value };
        if (isReg) body.name = name.value;
        const r = await api.call('POST', isReg ? '/api/auth/register' : '/api/auth/login', body);
        api.token = r.token;
        store.set('hayyak_token', r.token);
        state.user = null; // يُحمَّل من /api/me لمعرفة وضع الإرسال
        if (location.hash === (isReg ? '#/new' : '#/')) route();
        else location.hash = isReg ? '#/new' : '#/';
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
  isReg && field('اسمك', name),
  field('الدولة', country),
  field('رقم الجوال', phone, isReg ? 'اكتب الرقم كما تعرفه، مثل 0501234567. يُستخدم لتسجيل الدخول' : null),
  field('كلمة المرور', password, isReg ? '8 خانات على الأقل' : null),
  err,
  submit);

  return h('div', null,
    h('div', { class: 'auth-hero' },
      h('div', { class: 'brand-lg' }, 'حيّاك'),
      h('p', null, 'ادعُ ضيوفك، وتابع من يحضر')),
    h('div', { class: 'band', 'aria-hidden': 'true' }),
    h('div', { class: 'auth-body' },
      h('h1', null, isReg ? 'حساب جديد' : 'تسجيل الدخول'),
      form,
      h('p', { class: 'switch' },
        isReg ? 'عندك حساب؟ ' : 'أول مرة؟ ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => mount(viewAuth(isReg ? 'login' : 'register')) },
          isReg ? 'سجّل الدخول' : 'أنشئ حساباً'))));
}

// ───────── قائمة المناسبات ─────────
function eventRow(e) {
  const [day, month] = e.display.gregorian.split(' ');
  const s = e.stats;
  return h('a', { class: 'event-row' + (e.past ? ' past' : ''), href: `#/e/${e.id}` },
    h('div', { class: 'datebox', 'aria-hidden': 'true' }, h('span', { class: 'd' }, day), h('span', { class: 'm' }, month)),
    h('div', null,
      h('div', { class: 'event-title' }, e.title),
      h('span', { class: 'sr-only' }, e.display.gregorian),
      h('div', { class: 'event-sub' },
        h('span', null, `${e.display.weekday} ${e.display.time}`),
        h('span', null, e.venue)),
      h('div', { class: 'event-counts' },
        s.total
          ? [h('span', { class: 'ok' }, `${s.headcount} حاضر`), h('span', null, `${s.pending} بانتظار الرد`)]
          : h('span', { class: 'muted' }, 'لم تُضف معازيم بعد'))));
}

async function viewEvents() {
  const my = ++navId;
  mount(shell(h('p', { class: 'muted' }, 'جارٍ التحميل…')));
  let events;
  try {
    events = (await api.get('/api/events')).events;
  } catch (ex) {
    if (my === navId) mount(shell(errorBox(ex.message)));
    return;
  }
  if (my !== navId) return;

  const upcoming = events.filter((e) => !e.past);
  const past = events.filter((e) => e.past).reverse();
  const newBtn = h('a', { class: 'btn', href: '#/new' }, 'مناسبة جديدة');

  mount(shell(
    h('div', { class: 'page-head' }, h('h1', null, 'مناسباتي'), events.length > 0 && newBtn),
    events.length === 0
      ? h('div', { class: 'empty' },
        h('h2', null, 'ما عندك مناسبات بعد'),
        h('p', null, 'أنشئ أول مناسبة، ثم أضف أرقام ضيوفك وأرسل لهم الدعوات.'),
        h('a', { class: 'btn saffron', href: '#/new' }, 'أنشئ أول مناسبة'))
      : [
        upcoming.map(eventRow),
        past.length > 0 && [h('h2', { class: 'section-title' }, 'مناسبات سابقة'), past.map(eventRow)],
      ]));
}

// ───────── نموذج المناسبة (جديدة / تعديل) ─────────
async function viewEventForm(eventId) {
  const my = ++navId;
  mount(shell(h('p', { class: 'muted' }, 'جارٍ التحميل…')));
  let ev = null;
  if (eventId) {
    try {
      ev = (await api.get(`/api/events/${eventId}`)).event;
    } catch (ex) {
      if (my === navId) mount(shell(errorBox(ex.message)));
      return;
    }
    if (my !== navId) return;
  }
  let templates;
  try {
    templates = (await api.get('/api/templates')).templates;
  } catch (ex) {
    if (my === navId) mount(shell(errorBox(ex.message)));
    return;
  }
  if (my !== navId) return;
  const v = ev || {
    kind: 'wedding', template: 'najd', occasion: '', honorees: '', hostLine: '', date: '', time: '20:30', venue: '', mapUrl: '',
    notes: '', allowCompanions: true, maxCompanions: 2,
  };

  const kind = h('select', { value: v.kind },
    Object.entries(KIND_LABELS).map(([k, label]) => h('option', { value: k }, label)));
  const honorees = h('input', { type: 'text', maxlength: '100', value: v.honorees || '', placeholder: 'فهد و دانة' });
  const occasion = h('input', {
    type: 'text', maxlength: '60', value: v.occasion && v.occasion !== OCCASION_DEFAULTS[v.kind] ? v.occasion : '',
    placeholder: OCCASION_DEFAULTS[v.kind],
  });
  const hostLine = h('input', { type: 'text', maxlength: '100', value: v.hostLine, placeholder: 'حنان الجميعه و حصه العبدالعظيم' });
  const date = h('input', { type: 'date', value: v.date, min: ev ? null : todayRiyadh() });
  const time = h('input', { type: 'time', value: v.time });
  const venue = h('input', { type: 'text', maxlength: '200', value: v.venue, placeholder: 'قاعة الواحة، الرياض' });
  const mapUrl = h('input', {
    type: 'url', class: 'ltr', value: v.mapUrl, placeholder: 'https://maps.app.goo.gl/…',
  });
  const notes = h('textarea', {
    rows: '3', maxlength: '600', value: v.notes, placeholder: 'مثال: الحضور بعد صلاة العشاء',
  });
  const allow = h('input', { type: 'checkbox', checked: v.allowCompanions });
  const max = h('select', { value: String(v.maxCompanions || 2) },
    Array.from({ length: 10 }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
  const maxField = field('أقصى عدد مرافقين للضيف الواحد', max);
  const syncMax = () => { maxField.hidden = !allow.checked; };
  allow.addEventListener('change', syncMax);
  syncMax();

  // — اختيار القالب مع معاينة حيّة —
  const tplState = { value: v.template || 'najd', touched: !!ev };
  const tplOptions = new Map(); // id → { thumb, label, radio }
  const previewValues = () => ({
    title: `${occasion.value.trim() || OCCASION_DEFAULTS[kind.value]} ${honorees.value.trim()}`.trim(),
    hostLine: hostLine.value.trim(), date: date.value, time: time.value,
    venue: venue.value.trim(), notes: notes.value.trim(),
  });
  const drawThumbs = () => {
    const vals = previewValues();
    for (const { thumb } of tplOptions.values()) put(thumb, inviteMock(vals));
  };
  const selectTemplate = (id, manual) => {
    tplState.value = id;
    if (manual) tplState.touched = true;
    for (const [key, o] of tplOptions) {
      o.label.classList.toggle('selected', key === id);
      o.radio.checked = key === id;
    }
  };
  let drawTimer = null;
  const scheduleDraw = () => { clearTimeout(drawTimer); drawTimer = setTimeout(drawThumbs, 150); };
  for (const el of [honorees, occasion, hostLine, date, time, venue, notes]) {
    el.addEventListener('input', scheduleDraw);
    el.addEventListener('change', scheduleDraw);
  }
  kind.addEventListener('change', () => {
    occasion.placeholder = OCCASION_DEFAULTS[kind.value];
    scheduleDraw();
    if (!tplState.touched && templates.some((t) => t.id === SUGGESTED_TEMPLATE[kind.value])) {
      selectTemplate(SUGGESTED_TEMPLATE[kind.value], false);
    }
  });

  const pickerOptions = templates.map((t) => {
    const thumb = h('div', { class: 'tpl-thumb', 'data-theme': t.id });
    const radio = h('input', {
      type: 'radio', name: 'template', value: t.id, class: 'sr-only', checked: t.id === tplState.value,
      onchange: () => selectTemplate(t.id, true),
    });
    const label = h('label', { class: 'tpl' + (t.id === tplState.value ? ' selected' : '') },
      radio, thumb, h('span', { class: 'tpl-name' }, t.label), h('span', { class: 'tpl-note' }, t.note));
    tplOptions.set(t.id, { thumb, label, radio });
    return label;
  });
  drawThumbs();

  const picker = h('fieldset', { class: 'tpl-picker' },
    h('legend', null, 'قالب الدعوة'),
    h('p', { class: 'hint' }, 'اختر الشكل الذي تظهر به الدعوة لضيوفك. المعاينة تتحدث مع ما تكتبه في الحقول.'),
    h('div', { class: 'tpl-grid' }, pickerOptions),
    h('div', { class: 'form-actions' },
      h('button', {
        class: 'btn ghost small', type: 'button',
        onclick: () => openDialog('معاينة الدعوة',
          h('div', { class: 'preview-stage', 'data-theme': tplState.value }, inviteMock(previewValues()))),
      }, 'معاينة القالب المختار بحجم كامل')));

  const err = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn', type: 'submit' }, ev ? 'حفظ التعديلات' : 'إنشاء المناسبة');

  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      const body = {
        kind: kind.value, template: tplState.value, occasion: occasion.value, honorees: honorees.value, hostLine: hostLine.value, date: date.value, time: time.value,
        venue: venue.value, mapUrl: mapUrl.value, notes: notes.value,
        allowCompanions: allow.checked, maxCompanions: Number(max.value),
      };
      try {
        const r = ev ? await api.put(`/api/events/${ev.id}`, body) : await api.post('/api/events', body);
        toast(ev ? 'تم حفظ التعديلات' : 'تم إنشاء المناسبة، أضف معازيمك الآن');
        location.hash = `#/e/${r.event.id}`;
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  field('نوع المناسبة', kind),
  field('صاحب الدعوة', hostLine, 'من يدعو الضيوف، يظهر في الرسالة بعد «بكل الود والمحبة تتشرف»'),
  field('نوع الحفل (اختياري)', occasion, 'يظهر بعد «بدعوتكم لحضور». اتركه فارغاً لاستخدام الصيغة المعتادة لنوع المناسبة'),
  field('أسماء أصحاب المناسبة', honorees, 'مثل: العريس والعروس، أو اسم المخطوبة، أو المولود، أو الخريج'),
  h('div', { class: 'row2' }, field('التاريخ', date), field('الوقت', time, 'بتوقيت الرياض')),
  field('المكان', venue),
  field('رابط الموقع على الخرائط (اختياري)', mapUrl),
  field('ملاحظات للضيوف (اختياري)', notes),
  picker,
  h('div', { class: 'field' },
    h('label', { class: 'check-row' }, allow, 'السماح للضيف بإحضار مرافقين')),
  maxField,
  err,
  h('div', { class: 'form-actions' },
    submit,
    h('a', { class: 'btn ghost', href: ev ? `#/e/${ev.id}` : '#/' }, 'إلغاء')));

  const danger = ev && h('div', { class: 'field' },
    h('hr'),
    h('button', {
      class: 'btn danger', type: 'button',
      onclick: async () => {
        if (!confirm(`حذف «${ev.title}» نهائياً مع كل معازيمها وردودهم؟ لا يمكن التراجع.`)) return;
        try {
          await api.del(`/api/events/${ev.id}`);
          toast('تم حذف المناسبة');
          location.hash = '#/';
        } catch (ex) { toast(ex.message, 'error'); }
      },
    }, 'حذف المناسبة'));

  mount(shell(
    h('a', { class: 'back', href: ev ? `#/e/${ev.id}` : '#/' }, 'رجوع'),
    h('div', { class: 'page-head' }, h('h1', null, ev ? 'تعديل المناسبة' : 'مناسبة جديدة')),
    form,
    danger));
}

// ───────── صفحة المناسبة ─────────
function inviteMessage(g, e) {
  const from = e.hostLine ? ` من ${e.hostLine}` : '';
  return [
    `السلام عليكم ${g.name}`,
    `دعوة لحضور ${e.title}${from}`,
    `${e.display.weekday} ${e.display.gregorian} الساعة ${e.display.time}`,
    e.venue,
    `للرد على الدعوة: ${g.link}`,
  ].join('\n');
}

async function viewEvent(eventId) {
  const my = ++navId;
  mount(shell(h('p', { class: 'muted' }, 'جارٍ التحميل…')));
  let data;
  try {
    data = await api.get(`/api/events/${eventId}`);
  } catch (ex) {
    if (my === navId) mount(shell(errorBox(ex.message)));
    return;
  }
  if (my !== navId) return;

  let filter = 'all';
  let query = '';
  let pollTimer = null;
  const openMore = new Set();

  const headEl = h('section', { class: 'event-head' });
  const statsEl = h('section');
  const actionsEl = h('section');
  const listEl = h('div');
  const filterEls = {};

  const FILTERS = [['all', 'الكل'], ['accepted', 'حاضر'], ['maybe', 'ربما'], ['declined', 'معتذر'], ['pending', 'لم يرد']];
  const filtersEl = h('div', { class: 'filters', role: 'group', 'aria-label': 'تصفية المعازيم' },
    FILTERS.map(([key, label]) => {
      const count = h('span');
      const btn = h('button', {
        class: 'filter', type: 'button', 'aria-pressed': String(key === 'all'),
        onclick: () => {
          filter = key;
          for (const [k, f] of Object.entries(filterEls)) f.btn.setAttribute('aria-pressed', String(k === key));
          renderList();
        },
      }, label, count);
      filterEls[key] = { btn, count };
      return btn;
    }));
  const search = h('input', {
    type: 'search', placeholder: 'ابحث بالاسم أو الرقم', 'aria-label': 'بحث في المعازيم',
    oninput: (e) => { query = e.target.value.trim(); renderList(); },
  });

  const unsentCount = () => data.guests.filter((g) => g.inviteState === 'none' || g.inviteState === 'failed').length;

  // — الإجراءات —
  async function sendInvites() {
    const n = unsentCount();
    if (!n) return;
    const note = state.demoMode
      ? 'وضع تجريبي: لن تُرسل رسائل فعلية.'
      : state.channel === 'whatsapp'
        ? 'تصل الدعوة على واتساب بصورة البطاقة وأزرار الرد، وتُحتسب رسوم الرسالة لدى واتساب للأعمال.'
        : 'تُحتسب رسائل SMS من رصيدك لدى مزود الرسائل.';
    if (!confirm(`سيتم إرسال الدعوة إلى ${n} ضيف.\n${note}\nمتابعة؟`)) return;
    try {
      const r = await api.post(`/api/events/${eventId}/invite`);
      toast(`جارٍ إرسال ${r.queued} دعوة`);
      refresh();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function remindNow() {
    if (!confirm('سيصل الآن تذكير بطلب تأكيد الحضور لكل من وصلته دعوته ولم يعتذر.\nمتابعة؟')) return;
    try {
      const r = await api.post(`/api/events/${eventId}/remind`);
      toast(r.queued ? `جارٍ إرسال ${r.queued} تذكير` : 'لا يوجد ضيوف يحتاجون تذكيراً حالياً');
      refresh();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function exportCsv() {
    try {
      const res = await fetch(`/api/events/${eventId}/export.csv`, { headers: { Authorization: `Bearer ${api.token}` } });
      if (!res.ok) throw new Error('تعذّر تنزيل الملف');
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `${data.event.title.replace(/[\\/:*?"<>|]/g, '')}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function openOutbox() {
    const body = h('div', null, h('p', { class: 'muted' }, 'جارٍ التحميل…'));
    openDialog('سجل الرسائل', body);
    const load = async () => {
      try {
        const r = await api.get(`/api/events/${eventId}/outbox`);
        put(body,
          r.provider.endsWith('console') && h('p', { class: 'hint' },
            r.simulate
              ? 'وضع تجريبي: هذه الرسائل لم تُرسل فعلياً. اضغط على أزرار الرسالة لتجرّب كيف يرد الضيف، وستتحدث حالته في القائمة.'
              : 'وضع تجريبي: هذه الرسائل لم تُرسل فعلياً، وتظهر هنا لتراجع صياغتها.'),
          r.messages.length === 0 && h('p', { class: 'muted' }, 'لا توجد رسائل بعد.'),
          r.messages.map((m) => (m.channel === 'whatsapp' ? waBubble(m, r.simulate, load) : smsItem(m))));
      } catch (ex) { put(body, h('p', { class: 'form-error' }, ex.message)); }
    };
    load();
  }

  function smsItem(m) {
    return h('div', { class: 'msg-item' },
      h('header', null,
        h('span', null, `${KIND_MSG[m.kind] || 'رسالة'} إلى ${m.guestName || m.phone}`),
        h('span', { class: m.ok ? 'plus' : 'guest-meta bad' }, m.ok ? 'أُرسلت' : 'فشلت')),
      m.error && h('p', { class: 'hint' }, m.error),
      h('pre', null, m.body));
  }

  // رسالة واتساب بشكلها الحقيقي: صورة البطاقة والنص والأزرار
  function waBubble(m, simulate, reload) {
    const rich = (text) => text.split(/(\*[^*\n]+\*)/g).map((part) =>
      (/^\*[^*\n]+\*$/.test(part) ? h('b', null, part.slice(1, -1)) : part));
    const tap = async (b) => {
      try {
        const r = await api.post(`/api/events/${eventId}/guests/${m.guestId}/simulate`, { action: b.payload.split(':')[0] });
        toast(r.reply ? 'سُجّل ردّ الضيف، وأُرسل له تأكيد' : 'تعذّر تسجيل الرد', r.ok ? undefined : 'error');
        await reload();
        refresh();
      } catch (ex) { toast(ex.message, 'error'); }
    };
    const delivery = { sent: 'أُرسلت', delivered: 'وصلت', read: 'قُرئت' }[m.delivery];
    return h('div', { class: 'wa-item' },
      h('header', { class: 'wa-head' },
        h('span', null, `${KIND_MSG[m.kind] || 'رسالة'} إلى ${m.guestName || m.phone}`),
        h('span', { class: m.ok ? 'plus' : 'guest-meta bad' }, m.ok ? (delivery || 'أُرسلت') : 'فشلت')),
      m.error && h('p', { class: 'hint' }, m.error),
      h('div', { class: 'wa-bubble' },
        m.image && h('img', { class: 'wa-img', src: relUrl(m.image), alt: 'بطاقة الدعوة', loading: 'lazy' }),
        h('div', { class: 'wa-text' }, rich(m.body))),
      m.buttons && m.buttons.length > 0 && h('div', { class: 'wa-btns' },
        m.buttons.map((b) => h('button', {
          class: 'wa-btn', type: 'button', disabled: !simulate, title: simulate ? 'تجربة ضغط الضيف على الزر' : '',
          onclick: () => tap(b),
        }, b.label))));
  }

  function openAddGuests() {
    const ta = h('textarea', {
      rows: '8', 'aria-label': 'قائمة المعازيم',
      placeholder: 'محمد العتيبي 0501234567\nسارة الغامدي 0559876543\nخالد +201001234567',
    });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const honorific = h('select', null, HONORIFIC_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
    const country = countrySelect();
    const submit = h('button', { class: 'btn', type: 'submit' }, 'إضافة إلى القائمة');
    const canPick = 'contacts' in navigator && 'ContactsManager' in window;
    const picker = canPick && h('button', {
      class: 'btn ghost small', type: 'button',
      onclick: async () => {
        try {
          const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
          const lines = picked
            .filter((c) => c.tel && c.tel[0])
            .map((c) => `${(c.name && c.name[0]) || ''} ${c.tel[0]}`.trim());
          ta.value = (ta.value.trim() ? `${ta.value.trim()}\n` : '') + lines.join('\n');
        } catch { /* ألغى المستخدم الاختيار */ }
      },
    }, 'اختيار من جهات الاتصال');

    const body = h('div');
    const dlg = openDialog('إضافة معازيم', body);

    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!ta.value.trim()) { err.textContent = 'اكتب ضيفاً واحداً على الأقل (الاسم ثم الرقم)'; return; }
        submit.disabled = true;
        try {
          const r = await api.post(`/api/events/${eventId}/guests`, { text: ta.value, honorific: honorific.value, country: country.value });
          put(body,
            h('p', null, r.added ? `تمت إضافة ${r.added} ضيف.` : 'ما أُضيف أي ضيف جديد.'),
            r.duplicates.length > 0 && [
              h('p', { class: 'hint' }, `${r.duplicates.length} موجودون من قبل وتجاوزناهم:`),
              h('ul', { class: 'result-list' }, r.duplicates.map((d) => h('li', null, `${d.name} (${d.phone})`))),
            ],
            r.errors.length > 0 && [
              h('p', { class: 'hint' }, `${r.errors.length} سطر لم نقدر نقرأه:`),
              h('ul', { class: 'result-list' }, r.errors.map((x) => h('li', null, `${x.line}: ${x.reason}`))),
            ],
            r.added > 0 && h('p', { class: 'hint' }, 'الخطوة التالية: اضغط «إرسال الدعوات» لإرسالها لكل من أضفتهم.'),
            h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'تم')));
          refresh();
        } catch (ex) {
          err.textContent = ex.message;
          submit.disabled = false;
        }
      },
    },
    h('p', { class: 'hint' },
      'اكتب كل ضيف في سطر: الاسم ثم رقم الجوال. الأرقام السعودية تُقبل بأي صيغة (05… أو 5… أو +966…)، ولأرقام الدول الأخرى ابدأ بـ + ورمز الدولة.'),
    field('دولة الأرقام', country, 'تُضاف لأي رقم بدون رمز دولة. الأرقام المكتوبة بـ + تبقى كما هي، فتقدر تخلط أكثر من دولة في نفس القائمة.'),
    ta,
    field('اللقب في رسالة الدعوة', honorific, 'يظهر قبل اسم الضيف، مثل «المكرمة : سارة». تقدر تغيّره لأي ضيف لاحقاً من «خيارات ← تعديل».'),
    picker && h('div', { class: 'form-actions' }, picker),
    err,
    h('div', { class: 'form-actions' }, submit));
    put(body, form);
    ta.focus();
  }

  const HONORIFIC_OPTIONS = [['', 'بدون لقب'], ['f', 'المكرمة'], ['m', 'المكرم']];

  function openEditGuest(g) {
    const honorific = h('select', { value: g.honorific || '' },
      HONORIFIC_OPTIONS.map(([v, l]) => h('option', { value: v, selected: v === (g.honorific || '') }, l)));
    const name = h('input', { type: 'text', maxlength: '80', value: g.name });
    const phone = h('input', { type: 'tel', class: 'ltr', value: `+${g.phone}` });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const dlg = openDialog('تعديل ضيف', h('div'));
    const body = dlg.querySelector('.dlg-body');
    put(body, h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          await api.put(`/api/events/${eventId}/guests/${g.id}`, { name: name.value, phone: phone.value, honorific: honorific.value });
          dlg.close();
          toast('تم حفظ التعديل');
          refresh();
        } catch (ex) { err.textContent = ex.message; }
      },
    },
    field('الاسم', name),
    field('اللقب', honorific),
    field('رقم الجوال (مع رمز الدولة)', phone, 'إذا غيّرت الرقم تُعاد الدعوة إلى الرقم الجديد.'),
    err,
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'submit' }, 'حفظ'))));
  }

  function openCard(g) {
    const img = relUrl(g.cardUrl);
    const dlg = openDialog(`بطاقة ${g.name}`, h('div', { class: 'card-view' },
      h('img', { class: 'card-img', src: img, alt: `بطاقة دعوة ${g.name}` }),
      h('p', { class: 'hint' }, 'هذه البطاقة تصل للضيف في رسالة الواتساب، وفيها رمز QR خاص به يفتح صفحة دعوته.'),
      h('div', { class: 'form-actions' },
        h('a', { class: 'btn', href: img, download: `بطاقة-${g.name}.png` }, 'تنزيل البطاقة'),
        h('a', { class: 'btn ghost', href: relUrl(g.qrUrl), download: `qr-${g.name}.svg` }, 'تنزيل رمز QR'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { dlg.close(); copyLink(g); } }, 'نسخ الرابط'))));
  }

  async function copyLink(g) {
    try {
      await navigator.clipboard.writeText(g.link);
      toast('تم نسخ رابط الدعوة');
    } catch {
      prompt('انسخ رابط الدعوة:', g.link);
    }
  }

  async function resend(g) {
    try {
      await api.post(`/api/events/${eventId}/invite`, { guestIds: [g.id], resend: true });
      toast(`جارٍ إعادة إرسال الدعوة إلى ${g.name}`);
      refresh();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  async function removeGuest(g) {
    if (!confirm(`حذف ${g.name} من القائمة؟`)) return;
    try {
      await api.del(`/api/events/${eventId}/guests/${g.id}`);
      refresh();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  // — العرض —
  function renderHead() {
    const e = data.event;
    put(headEl,
      h('div', { class: 'page-head' },
        h('h1', null, e.title),
        h('a', { class: 'btn ghost small', href: `#/e/${e.id}/edit` }, 'تعديل')),
      e.hostLine && h('p', { class: 'host' }, `دعوة من ${e.hostLine}`),
      h('p', { class: 'when' }, `${e.display.weekday} ${e.display.gregorian}`),
      h('p', { class: 'when-sub' }, `${e.display.hijri}، الساعة ${e.display.time}`),
      h('p', { class: 'venue' },
        e.mapUrl ? h('a', { href: e.mapUrl, target: '_blank', rel: 'noopener noreferrer' }, e.venue) : e.venue),
      e.past && h('p', { class: 'past-note' }, 'انتهت هذه المناسبة، ولا يمكن إرسال دعوات أو تذكيرات جديدة.'));
  }

  function renderStats() {
    const s = data.stats;
    const cell = (cls, n, label, sub) =>
      h('div', { class: `stat ${cls}` }, h('b', null, n), h('span', null, label), sub && h('small', null, sub));
    const seg = (cls, n) => {
      if (!n) return null;
      const i = h('i', { class: cls });
      i.style.flexGrow = String(n);
      return i;
    };
    let note = 'لم تُضف معازيم بعد.';
    if (s.total) {
      note = `وصلت الدعوة إلى ${s.invited} من ${s.total}`;
      if (s.reminded) note += `، ووصل التذكير إلى ${s.reminded}`;
      note += '.';
      if (s.reconfirmed || s.cancelledAfterReminder) {
        note += ` بعد التذكير: أكّد ${s.reconfirmed}، واعتذر ${s.cancelledAfterReminder}.`;
      }
    }
    put(statsEl,
      h('div', { class: 'stats' },
        cell('ok', s.headcount, 'حاضر',
          s.companions ? [h('span', null, `${s.accepted} ضيف`), h('span', null, `${s.companions} مرافق`)] : null),
        cell('maybe', s.maybe, 'ربما'),
        cell('no', s.declined, 'معتذر'),
        cell('pend', s.pending, 'لم يرد')),
      h('div', {
        class: 'bar', role: 'img',
        'aria-label': `حاضر ${s.accepted}، ربما ${s.maybe}، معتذر ${s.declined}، لم يرد ${s.pending}`,
      }, seg('s-ok', s.accepted), seg('s-maybe', s.maybe), seg('s-no', s.declined), seg('s-pend', s.pending)),
      h('p', { class: 'progress-note' }, note));
  }

  function reminderNote(e) {
    if (e.reminder.passed) {
      return 'التذكير التلقائي يُرسل لمن لم يعتذر بعد مرور 12 ساعة على وصول دعوته.';
    }
    const r = e.reminder.display;
    return `سيُرسل التذكير تلقائياً لمن لم يعتذر يوم ${r.weekday} ${r.gregorian} الساعة ${r.time}، ويطلب منهم تأكيد الحضور مرة ثانية.`;
  }

  function renderActions() {
    const e = data.event;
    const unsent = unsentCount();
    const sending = data.sending;
    put(actionsEl,
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn', type: 'button', disabled: e.past || sending || unsent === 0, onclick: sendInvites,
        }, sending ? 'جارٍ الإرسال…' : unsent ? `إرسال الدعوات (${unsent})` : 'أُرسلت كل الدعوات'),
        h('button', { class: 'btn ghost', type: 'button', onclick: openAddGuests }, 'إضافة معازيم')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost small', type: 'button', disabled: e.past || sending, onclick: remindNow }, 'إرسال تذكير الآن'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: exportCsv }, 'تنزيل القائمة (Excel)'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: openOutbox }, 'سجل الرسائل')),
      !e.past && h('p', { class: 'reminder-note' }, reminderNote(e)));
  }

  function guestRow(g) {
    const e = data.event;
    const invite = {
      none: h('span', null, 'لم تُرسل الدعوة'),
      queued: h('span', null, 'جارٍ إرسال الدعوة…'),
      sent: h('span', null, { read: 'قرأ الدعوة', delivered: 'وصلت جواله' }[g.inviteDelivery] || 'وصلته الدعوة'),
      failed: h('span', { class: 'bad' }, `تعذّر إرسال الدعوة${g.inviteError ? `: ${g.inviteError}` : ''}`),
    }[g.inviteState];
    const reminder = {
      queued: h('span', null, 'جارٍ إرسال التذكير…'),
      sent: h('span', null, { read: 'قرأ التذكير', delivered: 'وصل جواله التذكير' }[g.reminderDelivery] || 'وصله التذكير'),
      failed: h('span', { class: 'bad' }, `تعذّر إرسال التذكير${g.reminderError ? `: ${g.reminderError}` : ''}`),
    }[g.reminderState];
    const final = {
      accepted: h('span', { class: 'good' }, 'أكّد حضوره بعد التذكير'),
      declined: h('span', { class: 'bad' }, 'اعتذر بعد التذكير'),
      maybe: h('span', null, 'ردّ بـ«ربما» بعد التذكير'),
    }[g.finalStatus];

    const wa = `https://wa.me/${g.phone}?text=${encodeURIComponent(inviteMessage(g, e))}`;
    return h('div', { class: 'guest-row' },
      h('div', { class: 'guest-main' },
        h('div', null, h('div', { class: 'guest-name' }, g.name), h('div', { class: 'guest-phone' }, g.phoneDisplay)),
        h('div', { class: 'guest-state' },
          g.status === 'accepted' && g.companions > 0 && h('span', { class: 'plus' }, `+${g.companions}`),
          h('span', { class: `chip ${g.status}` }, STATUS_LABELS[g.status]))),
      h('div', { class: 'guest-meta' }, invite, reminder, final),
      h('div', { class: 'guest-actions' },
        h('a', { class: 'link-btn', href: wa, target: '_blank', rel: 'noopener noreferrer' }, 'إرسال عبر واتساب'),
        moreMenu(g, e)));
  }

  // الإجراءات الثانوية داخل «خيارات»؛ نتذكّر المفتوح منها كي لا يُغلق عند التحديث التلقائي
  function moreMenu(g, e) {
    const details = h('details', { class: 'more', open: openMore.has(g.id) },
      h('summary', null, 'خيارات'),
      h('div', { class: 'more-items' },
        h('button', { class: 'link-btn', type: 'button', onclick: () => openCard(g) }, 'بطاقة الدعوة و QR'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => copyLink(g) }, 'نسخ الرابط'),
        !e.past && (g.inviteState === 'sent' || g.inviteState === 'failed') &&
          h('button', { class: 'link-btn', type: 'button', onclick: () => resend(g) }, 'إعادة إرسال الدعوة'),
        h('button', { class: 'link-btn', type: 'button', onclick: () => openEditGuest(g) }, 'تعديل'),
        h('button', { class: 'link-btn danger', type: 'button', onclick: () => removeGuest(g) }, 'حذف')));
    details.addEventListener('toggle', () => {
      if (details.open) openMore.add(g.id);
      else openMore.delete(g.id);
    });
    return details;
  }

  function renderList() {
    const s = data.stats;
    filterEls.all.count.textContent = s.total;
    filterEls.accepted.count.textContent = s.accepted;
    filterEls.maybe.count.textContent = s.maybe;
    filterEls.declined.count.textContent = s.declined;
    filterEls.pending.count.textContent = s.pending;

    if (!data.guests.length) {
      put(listEl, h('div', { class: 'empty' },
        h('h2', null, 'ما أضفت معازيم بعد'),
        h('p', null, 'ألصق الأسماء والأرقام وسنجهّز لكل ضيف رابط دعوة خاص به.'),
        h('button', { class: 'btn saffron', type: 'button', onclick: openAddGuests }, 'إضافة معازيم')));
      return;
    }
    const q = query.toLowerCase();
    const digits = toLatin(query).replace(/\D/g, '').replace(/^0+/, '');
    const rows = data.guests.filter((g) =>
      (filter === 'all' || g.status === filter) &&
      (!query || g.name.toLowerCase().includes(q) || (digits.length >= 3 && g.phone.includes(digits))));
    put(listEl, rows.length ? rows.map(guestRow) : h('p', { class: 'muted' }, 'ما فيه ضيوف يطابقون هذا البحث.'));
  }

  function renderAll() {
    renderHead();
    renderStats();
    renderActions();
    renderList();
  }

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (document.hidden) schedule();
      else refresh();
    }, data.sending ? 1500 : 15000);
  }

  async function refresh() {
    try {
      const d = await api.get(`/api/events/${eventId}`);
      if (my !== navId) return;
      data = d;
      renderAll();
    } catch { /* خطأ مؤقت، نعيد المحاولة في الدورة التالية */ }
    schedule();
  }

  cleanup = () => clearTimeout(pollTimer);

  renderAll();
  mount(shell(
    h('a', { class: 'back', href: '#/' }, 'مناسباتي'),
    headEl, statsEl, actionsEl,
    h('section', { class: 'toolbar' }, h('h2', null, 'المعازيم'), search, filtersEl),
    listEl));
  schedule();
}

// ───────── التوجيه ─────────
const routes = [
  [/^#\/?$/, () => viewEvents()],
  [/^#\/new$/, () => viewEventForm()],
  [/^#\/e\/(\d+)$/, (m) => viewEvent(Number(m[1]))],
  [/^#\/e\/(\d+)\/edit$/, (m) => viewEventForm(Number(m[1]))],
];

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  navId += 1;
  if (!api.token) { mount(viewAuth()); return; }
  if (!state.user) {
    const my = navId;
    try {
      const me = await api.get('/api/me');
      state.user = me.user;
      state.demoMode = me.demoMode;
      state.channel = me.channel;
      state.problems = me.whatsappProblems || [];
    } catch {
      if (my === navId) mount(viewAuth());
      return;
    }
    if (my !== navId) return;
  }
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) { fn(m); return; }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
route();
