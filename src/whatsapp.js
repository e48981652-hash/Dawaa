// واتساب للأعمال (Meta WhatsApp Cloud API): دعوة بصورة البطاقة وثلاثة أزرار، واستقبال ضغطات الأزرار عبر Webhook.
//
// الرسائل المبادَرة من التطبيق لازم تكون «قوالب» معتمدة مسبقاً من Meta. نصوص القالبين أدناه (BODY_*) هي بالضبط
// ما يُنشأ في WhatsApp Manager (انظر README). المتغيرات {{1}} {{2}}… تُملأ من بيانات الضيف والمناسبة.
//
// WHATSAPP_MODE=console يعرض الرسالة بنفس شكلها داخل التطبيق ويمكن تجربة الضغط على الأزرار، بدون أي إرسال فعلي.
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./env');
const { describe, dotted, daysUntil } = require('./format');
const { recordResponse } = require('./responses');

// ───────── نصوص القوالب ─────────
const BODY_INVITE = [
  'السلام عليكم ورحمة الله وبركاته',
  '',
  '*{{1}}*',
  '',
  'بكل الود والمحبة تتشرف',
  '*{{2}}*',
  '',
  'بدعوتكم لحضور {{3}}',
  '*{{4}}*',
  '',
  'وذلك:-',
  '🗓️| {{5}}',
  '📍| {{6}}',
  '',
  '📌 يسعدنا تأكيد حضوركم وذلك بالضغط على أيقونة قبول الدعوة بالرسالة أدناه',
].join('\n');

const BODY_REMINDER = [
  'السلام عليكم ورحمة الله وبركاته',
  '',
  '*{{1}}*',
  '',
  'نذكّركم بدعوتكم لحضور {{2}}',
  '*{{3}}*',
  '',
  'وذلك {{4}}',
  '📍| {{5}}',
  '',
  '📌 نأمل تأكيد حضوركم مرة أخرى بالضغط على أحد الأزرار أدناه',
].join('\n');

const BUTTONS = {
  invite: [
    { action: 'a', label: 'قبول الدعوة' },
    { action: 'd', label: 'الاعتذار عن الدعوة' },
    { action: 'l', label: 'موقع المناسبة' },
  ],
  reminder: [
    { action: 'a', label: 'أؤكد حضوري' },
    { action: 'd', label: 'أعتذر عن الحضور' },
    { action: 'l', label: 'موقع المناسبة' },
  ],
};

const fill = (tpl, params) => tpl.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');

// Meta ترفض المتغيرات التي تحوي أسطراً جديدة أو أكثر من 4 مسافات متتالية
const param = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, 900) || '-';

const HONORIFIC = { m: 'المكرم', f: 'المكرمة' };
const greeting = (g) => (HONORIFIC[g.honorific] ? `${HONORIFIC[g.honorific]} : ${g.name}` : g.name);

const cardUrl = (g) => `${cfg.PUBLIC_BASE_URL}/card/${g.token}.png`;

/** إعدادات واتساب الناقصة في وضع الإرسال الفعلي (تظهر للمنظّم كتنبيه) */
function configProblems() {
  if (cfg.INVITE_CHANNEL !== 'whatsapp' || cfg.WHATSAPP_MODE !== 'cloud') return [];
  const p = [];
  if (!cfg.WHATSAPP_TOKEN) p.push('WHATSAPP_TOKEN (مفتاح الوصول من Meta)');
  if (!cfg.WHATSAPP_PHONE_ID) p.push('WHATSAPP_PHONE_ID (معرّف رقم واتساب)');
  if (!/^https:\/\//.test(cfg.PUBLIC_BASE_URL)) p.push('PUBLIC_BASE_URL لازم يكون رابط https عام');
  if (!cfg.WHATSAPP_APP_SECRET) p.push('WHATSAPP_APP_SECRET (لاستقبال ضغطات الأزرار)');
  if (!cfg.WHATSAPP_VERIFY_TOKEN) p.push('WHATSAPP_VERIFY_TOKEN (لربط الـ Webhook)');
  return p;
}

/** يرجع ما ينقص المناسبة لإرسالها عبر واتساب، أو null */
function missingForWhatsApp(event) {
  if (!event.host_line) return 'اكتب اسم صاحب الدعوة (مثل: عائلة العتيبي) قبل إرسال الدعوات';
  if (!event.honorees) return 'اكتب أسماء أصحاب المناسبة (مثل: سلطان و ريم) قبل إرسال الدعوات';
  return null;
}

/** يبني الرسالة: اسم القالب، المتغيرات، النص الكامل للمعاينة، الصورة، الأزرار */
function build(kind, guest, event, now = new Date()) {
  const d = describe(event.starts_at);
  const when = `يوم ${d.weekday} ${dotted(event.starts_at)} الساعة ${d.time}`;
  const occasion = event.occasion || 'مناسبتنا';
  let params;
  let body;
  if (kind === 'reminder') {
    const n = daysUntil(event.starts_at, now);
    const day = n === 0 ? 'اليوم' : n === 1 ? 'غداً' : '';
    params = [greeting(guest), occasion, event.honorees, `${day ? day + ' ' : ''}${when}`.trim(), event.venue];
    body = BODY_REMINDER;
  } else {
    // الدعوة: التاريخ فقط (الساعة والتاريخ الهجري على صورة البطاقة)، كما في النموذج المطلوب
    params = [greeting(guest), event.host_line, occasion, event.honorees, `يوم ${d.weekday} ${dotted(event.starts_at)}`, event.venue];
    body = BODY_INVITE;
  }
  params = params.map(param);
  return {
    kind,
    template: kind === 'reminder' ? cfg.WHATSAPP_TEMPLATE_REMINDER : cfg.WHATSAPP_TEMPLATE_INVITE,
    params,
    text: fill(body, params),
    image: cardUrl(guest),
    buttons: BUTTONS[kind].map((b) => ({ label: b.label, payload: `${b.action}:${guest.token}` })),
  };
}

/** حمولة Meta لرسالة القالب */
function templatePayload(to, msg) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: msg.template,
      language: { code: cfg.WHATSAPP_LANG },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: msg.image } }] },
        { type: 'body', parameters: msg.params.map((text) => ({ type: 'text', text })) },
        ...msg.buttons.map((b, i) => ({
          type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: b.payload }],
        })),
      ],
    },
  };
}

async function post(payload) {
  if (!cfg.WHATSAPP_TOKEN || !cfg.WHATSAPP_PHONE_ID) {
    throw new Error('إعدادات واتساب ناقصة: WHATSAPP_TOKEN و WHATSAPP_PHONE_ID');
  }
  const res = await fetch(`https://graph.facebook.com/${cfg.WHATSAPP_API_VERSION}/${cfg.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try { data = await res.json(); } catch { /* بدون JSON */ }
  if (!res.ok) {
    const e = data.error || {};
    throw new Error(`${e.message || 'رفض واتساب الطلب'} (HTTP ${res.status}${e.code ? `، رمز ${e.code}` : ''})`);
  }
  return data.messages && data.messages[0] ? data.messages[0].id : null;
}

function logOutbox({ guestId, eventId, kind, to, body, ok, error, meta, extId }) {
  db.prepare(
    `INSERT INTO outbox (guest_id, event_id, kind, to_phone, body, provider, channel, meta, ext_id, delivery, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?)`,
  ).run(
    guestId, eventId, kind, to, body, `whatsapp-${cfg.WHATSAPP_MODE}`, meta ? JSON.stringify(meta) : null, extId || null,
    ok && cfg.WHATSAPP_MODE === 'console' ? 'sent' : null, ok ? 1 : 0, error || null,
  );
}

/** إرسال دعوة أو تذكير (قالب). يرجع { ok, error } ولا يرمي. */
async function sendTemplate(kind, guest, event) {
  const msg = build(kind, guest, event);
  const meta = { template: msg.template, image: msg.image, buttons: msg.buttons.map((b) => ({ label: b.label, payload: b.payload })) };
  let ok = false;
  let error = null;
  let extId = null;
  try {
    if (cfg.WHATSAPP_MODE === 'cloud') {
      if (!/^https:\/\//.test(cfg.PUBLIC_BASE_URL)) {
        throw new Error('PUBLIC_BASE_URL لازم يكون رابط https عام ليتمكن واتساب من تحميل صورة البطاقة');
      }
      extId = await post(templatePayload(guest.phone, msg));
    } else {
      extId = `console-${crypto.randomBytes(6).toString('hex')}`;
      console.log(`[واتساب تجريبي] ${kind} إلى ${guest.phone}\n${msg.text}\n`);
    }
    ok = true;
  } catch (err) {
    error = String(err.message || err).slice(0, 300);
  }
  logOutbox({ guestId: guest.id, eventId: event.id, kind, to: guest.phone, body: msg.text, ok, error, meta, extId });
  return { ok, error };
}

/** رد نصي حر (مسموح خلال 24 ساعة من آخر رسالة من الضيف، وضغط الزر يفتح هذه النافذة) */
async function sendText(guest, event, body) {
  let ok = false;
  let error = null;
  let extId = null;
  try {
    if (cfg.WHATSAPP_MODE === 'cloud') {
      extId = await post({
        messaging_product: 'whatsapp', to: guest.phone, type: 'text', text: { preview_url: true, body },
      });
    } else {
      extId = `console-${crypto.randomBytes(6).toString('hex')}`;
    }
    ok = true;
  } catch (err) {
    error = String(err.message || err).slice(0, 300);
    console.error('تعذّر إرسال رد واتساب:', error);
  }
  logOutbox({ guestId: guest.id, eventId: event.id, kind: 'reply', to: guest.phone, body, ok, error, extId });
  return { ok, error, body };
}

// ───────── ضغطات الأزرار ─────────
function replyFor(action, guest, event) {
  const link = `${cfg.PUBLIC_BASE_URL}/i/${guest.token}`;
  if (action === 'a') {
    return ['شكراً لكم، تم تسجيل قبولكم للدعوة ✅', 'نتشرف بحضوركم.',
      event.allow_companions ? `لإضافة مرافقين وعرض بطاقتكم: ${link}` : `لعرض بطاقتكم: ${link}`].join('\n');
  }
  if (action === 'd') return 'نشكر لكم ردّكم، تم تسجيل اعتذاركم. نقدّر لكم ذلك 🤍';
  return ['📍 موقع المناسبة:', event.venue, event.map_url].filter(Boolean).join('\n');
}

/**
 * يعالج ضغطة زر. payload بصيغة a:TOKEN | d:TOKEN | l:TOKEN، و from رقم المرسل.
 * يرجع { handled, reply } حيث reply نتيجة sendText أو null.
 */
async function handleButton(payload, from = null) {
  const m = /^([adl]):([\w-]{8,64})$/.exec(String(payload || ''));
  if (!m) return { handled: false };
  const [, action, token] = m;
  const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
  if (!guest) return { handled: false };
  if (from && String(from).replace(/\D/g, '') !== guest.phone) {
    console.warn('[واتساب] تجاهل ضغطة زر من رقم غير رقم الضيف');
    return { handled: false };
  }
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(guest.event_id);
  if (new Date(event.starts_at) <= new Date()) {
    return { handled: true, reply: await sendText(guest, event, 'انتهت المناسبة. شكراً لكم 🤍') };
  }
  if (action !== 'l') {
    recordResponse(guest, event, action === 'a' ? 'accepted' : 'declined', action === 'a' ? guest.companions : 0);
  }
  return { handled: true, action, reply: await sendText(guest, event, replyFor(action, guest, event)) };
}

// ───────── Webhook ─────────
const RANK = { sent: 1, delivered: 2, read: 3 };

function applyStatus(s) {
  const row = db.prepare('SELECT * FROM outbox WHERE ext_id = ?').get(String(s.id));
  if (!row || !['sent', 'delivered', 'read', 'failed'].includes(s.status)) return;
  if (s.status !== 'failed' && (RANK[row.delivery] || 0) >= RANK[s.status]) return;
  db.prepare('UPDATE outbox SET delivery = ? WHERE id = ?').run(s.status, row.id);
  if (!row.guest_id || (row.kind !== 'invite' && row.kind !== 'reminder')) return;
  const col = row.kind === 'invite' ? 'invite' : 'reminder';
  db.prepare(`UPDATE guests SET ${col}_delivery = ? WHERE id = ?`).run(s.status, row.guest_id);
  if (s.status === 'failed') {
    const e = (s.errors && s.errors[0]) || {};
    const why = String(e.message || e.title || 'تعذّر تسليم الرسالة').slice(0, 300);
    db.prepare(`UPDATE guests SET ${col}_state = 'failed', ${col}_error = ? WHERE id = ?`).run(why, row.guest_id);
  }
}

async function processWebhook(body) {
  if (!body || body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      for (const s of v.statuses || []) applyStatus(s);
      for (const m of v.messages || []) {
        const payload = (m.button && m.button.payload) || (m.interactive && m.interactive.button_reply && m.interactive.button_reply.id);
        if (payload) await handleButton(payload, m.from);
      }
    }
  }
}

function verifySignature(rawBody, header) {
  if (!cfg.WHATSAPP_APP_SECRET || !rawBody || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  BODY_INVITE, BODY_REMINDER, BUTTONS, build, templatePayload, sendTemplate, sendText, handleButton,
  processWebhook, verifySignature, missingForWhatsApp, configProblems, cardUrl, fill,
};
