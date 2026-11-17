// واجهة واتساب للتطبيق. المزوّد الوحيد الآن هو WAHA (محرك WEBJS) — انظر src/waha.js.
//
// الأزرار التفاعلية (sendButtons) أوقفتها WAHA رسميًا (deprecated)، فالبديل المعتمد هو
// استفتاء بخيارَي القبول/الاعتذار، مع رابط صفحة الدعوة داخل نص الرسالة كشبكة أمان.
// الردود تصل من WAHA عبر /webhooks/waha ثم تُمرَّر إلى handleButton() هنا — نفس الدالة
// التي تستخدمها صفحة الضيف — فيتحدث guests.status والداشبورد بنفس المسار.
//
// WHATSAPP_MODE=console يعرض الرسالة داخل «سجل الرسائل» ويمكن تجربة ضغطاتها بدون إرسال فعلي.
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./env');
const waha = require('./waha');
const { describe, dotted, daysUntil } = require('./format');
const { recordResponse } = require('./responses');

// ───────── نصوص الرسائل ─────────
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
  '📌 يسعدنا تأكيد حضوركم بالضغط على أحد خياري الاستفتاء بالرسالة أدناه',
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
  '📌 نأمل تأكيد حضوركم مرة أخرى بالضغط على أحد خياري الاستفتاء أدناه',
].join('\n');

// خيارا الاستفتاء لكل نوع رسالة (الموقع يظهر في نص الرسالة وليس خياراً)
const BUTTONS = {
  invite: [
    { action: 'a', label: 'قبول الدعوة' },
    { action: 'd', label: 'الاعتذار عن الدعوة' },
  ],
  reminder: [
    { action: 'a', label: 'أؤكد حضوري' },
    { action: 'd', label: 'أعتذر عن الحضور' },
  ],
};

const fill = (tpl, params) => tpl.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? '');

// توحيد الفراغات داخل المتغيرات (يبقى النص سطراً واحداً كما كان في قوالب Meta)
const param = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, 900) || '-';

const HONORIFIC = { m: 'المكرم', f: 'المكرمة' };
const greeting = (g) => (HONORIFIC[g.honorific] ? `${HONORIFIC[g.honorific]} : ${g.name}` : g.name);

const cardUrl = (g) => `${cfg.PUBLIC_BASE_URL}/card/${g.token}.png`;

/** إعدادات واتساب الناقصة في وضع الإرسال الفعلي (تظهر للمنظّم كتنبيه) */
function configProblems() {
  if (cfg.INVITE_CHANNEL !== 'whatsapp' || cfg.WHATSAPP_MODE !== 'waha') return [];
  const p = [];
  if (!/^https:\/\//.test(cfg.PUBLIC_BASE_URL)) p.push('PUBLIC_BASE_URL لازم يكون رابط https يصل إليه الضيف (روابط الدعوة)');
  if (!cfg.WAHA_BASE_URL) p.push('WAHA_BASE_URL (عنوان خدمة WAHA)');
  if (!cfg.WAHA_WEBHOOK_HMAC_KEY) p.push('WAHA_WEBHOOK_HMAC_KEY (للتحقق من توقيع الردود الواردة)');
  return p;
}

/** يرجع ما ينقص المناسبة لإرسالها عبر واتساب، أو null */
function missingForWhatsApp(event) {
  if (!event.host_line) return 'اكتب اسم صاحب الدعوة (مثل: عائلة العتيبي) قبل إرسال الدعوات';
  if (!event.honorees) return 'اكتب أسماء أصحاب المناسبة (مثل: سلطان و ريم) قبل إرسال الدعوات';
  return null;
}

/** يبني الرسالة: النص الكامل للمعاينة، رابط البطاقة، وخيارا الاستفتاء */
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
    // الدعوة: التاريخ فقط (الساعة والتاريخ الهجري على صورة البطاقة)
    params = [greeting(guest), event.host_line, occasion, event.honorees, `يوم ${d.weekday} ${dotted(event.starts_at)}`, event.venue];
    body = BODY_INVITE;
  }
  params = params.map(param);
  return {
    kind,
    params,
    text: fill(body, params),
    image: cardUrl(guest),
    buttons: BUTTONS[kind].map((b) => ({ label: b.label, payload: `${b.action}:${guest.token}` })),
  };
}

function logOutbox({ guestId, eventId, kind, to, body, ok, error, meta, extId, pollExtId, source }) {
  const id = (v) => (v === null || v === undefined ? null : String(v));
  db.prepare(
    `INSERT INTO outbox (guest_id, event_id, kind, to_phone, body, provider, channel, meta, ext_id, poll_ext_id, source, delivery, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    guestId, eventId, kind, to, body, `whatsapp-${cfg.WHATSAPP_MODE}`, meta ? JSON.stringify(meta) : null,
    id(extId), id(pollExtId), source || cfg.WHATSAPP_MODE,
    ok && cfg.WHATSAPP_MODE === 'console' ? 'sent' : null, ok ? 1 : 0, error || null,
  );
}

/** إرسال دعوة أو تذكير (صورة + استفتاء). يرجع { ok, error } ولا يرمي. */
async function sendTemplate(kind, guest, event) {
  const msg = build(kind, guest, event);
  const options = msg.buttons.map((b) => ({ label: b.label, action: b.payload.split(':')[0] }));

  if (cfg.WHATSAPP_MODE === 'waha') {
    const r = await waha.sendInvite(kind, guest, event, msg);
    logOutbox({
      guestId: guest.id, eventId: event.id, kind, to: guest.phone, body: r.caption || msg.text,
      ok: r.ok, error: r.error, meta: r.meta, extId: r.imageId, pollExtId: r.pollId, source: 'waha',
    });
    return { ok: r.ok, error: r.error };
  }

  // وضع المعاينة: لا إرسال، ويظهر في السجل بأزرار قابلة للتجربة
  const meta = {
    interactive: 'poll',
    options,
    image: msg.image,
    buttons: msg.buttons,
    caption: msg.text,
  };
  console.log(`[واتساب تجريبي] ${kind} إلى ${guest.phone}\n${msg.text}\n`);
  logOutbox({
    guestId: guest.id, eventId: event.id, kind, to: guest.phone, body: msg.text,
    ok: true, error: null, meta, extId: `console-${crypto.randomBytes(6).toString('hex')}`, source: 'console',
  });
  return { ok: true, error: null };
}

/** رد نصي حر على الضيف */
async function sendText(guest, event, body) {
  let ok = false;
  let error = null;
  let extId = null;
  if (cfg.WHATSAPP_MODE === 'waha') {
    const r = await waha.sendText(guest.phone, body);
    ok = r.ok;
    error = r.error;
    extId = r.extId;
  } else {
    extId = `console-${crypto.randomBytes(6).toString('hex')}`;
    ok = true;
  }
  if (!ok) console.error('تعذّر إرسال رد واتساب:', error);
  logOutbox({
    guestId: guest.id, eventId: event.id, kind: 'reply', to: guest.phone, body,
    ok, error, extId, source: cfg.WHATSAPP_MODE,
  });
  return { ok, error, body };
}

// ───────── الردود ─────────
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
 * يعالج ردّ الضيف. payload بصيغة a:TOKEN | d:TOKEN | l:TOKEN، و from رقم المرسل.
 * يرجع { handled, reply } حيث reply نتيجة sendText أو null.
 */
async function handleButton(payload, from = null) {
  const m = /^([adl]):([\w-]{8,64})$/.exec(String(payload || ''));
  if (!m) return { handled: false };
  const [, action, token] = m;
  const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
  if (!guest) return { handled: false };
  if (from && String(from).replace(/\D/g, '') !== guest.phone) {
    console.warn('[واتساب] تجاهل ردّ من رقم غير رقم الضيف');
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

module.exports = {
  BODY_INVITE, BODY_REMINDER, BUTTONS, build, sendTemplate, sendText, handleButton,
  replyFor, missingForWhatsApp, configProblems, cardUrl, fill, logOutbox,
};
