// تكامل WAHA (WhatsApp HTTP API) — محرك WEBJS.
//
// الأزرار التفاعلية (sendButtons) أوقفتها WAHA رسميًا (deprecated)، فالبديل المدعوم هو
// استفتاء (sendPoll) بخيارَي القبول/الاعتذار، مع رابط صفحة الدعوة داخل النص كشبكة أمان.
// الردود تصل عبر Webhook موقَّع بـ HMAC-SHA512، ثم تُمرَّر إلى whatsapp.handleButton()
// نفسها المستخدمة في صفحة الضيف — أي أن قاعدة البيانات والداشبورد يتحدثان بنفس المسار.
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./env');
const { renderCard } = require('./card');

const SESSION = () => cfg.WAHA_SESSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).slice(0, 300);

function chatId(phone) {
  return `${String(phone).replace(/\D/g, '')}@c.us`;
}

function idOf(data) {
  if (!data) return null;
  const v = data.id || (data._data && data._data.id) || null;
  if (v === null || v === undefined) return null;
  // WEBJS قد يرجع المعرّف كائناً: { fromMe, remote, id, _serialized }
  if (typeof v === 'object') {
    const s = v._serialized || v.id || null;
    return s === null || s === undefined ? null : String(s);
  }
  return String(v);
}

async function api(path, payload) {
  if (!cfg.WAHA_BASE_URL) throw new Error('WAHA_BASE_URL غير مضبوط');
  const res = await fetch(cfg.WAHA_BASE_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.WAHA_API_KEY ? { 'X-Api-Key': cfg.WAHA_API_KEY } : {}),
    },
    body: JSON.stringify({ session: SESSION(), ...payload }),
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* قد لا يوجد جسم */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `WAHA رفض الطلب (HTTP ${res.status})`;
    throw new Error(String(msg).slice(0, 300));
  }
  return data;
}

/** فاصل زمني عشوائي بين الرسائل لتقليل خطر الحظر */
function gap() {
  const jitter = Math.random() * cfg.WAHA_SEND_JITTER_MS;
  return sleep(cfg.WAHA_SEND_DELAY_MS + jitter);
}

/** نص الرسالة: نص الدعوة + رابط الخريطة + رابط الرد (شبكة أمان لو فشل الاستفتاء) */
function captionFor(guest, event, msg) {
  const link = `${cfg.PUBLIC_BASE_URL}/i/${guest.token}`;
  const lines = [msg.text, ''];
  if (event.map_url) lines.push(`🗺️ موقع المناسبة: ${event.map_url}`);
  lines.push(`🔗 للرد على الدعوة: ${link}`);
  return lines.join('\n');
}

function cardUrl(guest) {
  return `${cfg.PUBLIC_BASE_URL}/card/${guest.token}.png`;
}

/**
 * إرسال دعوة/تذكير عبر WAHA: صورة البطاقة (base64) ثم استفتاء بخيارين.
 * لو فشل الاستفتاء نرسل النص نفسه (يحمل الرابط) كبديل. يرجع بيانات للتسجيل في outbox.
 */
async function sendInvite(kind, guest, event, msg) {
  const options = msg.buttons
    .filter((b) => /^[ad]:/.test(b.payload))
    .map((b) => ({ label: b.label, action: b.payload.split(':')[0] }));
  const caption = captionFor(guest, event, msg);
  const meta = {
    interactive: 'poll',
    options,
    image: cardUrl(guest),
    caption,
    fallback: false,
  };

  let imageId = null;
  try {
    const png = renderCard({
      template: event.template,
      occasion: event.occasion || 'مناسبتنا',
      host: event.host_line,
      honorees: event.honorees,
      startsAt: event.starts_at,
      venue: event.venue,
      qrUrl: `${cfg.PUBLIC_BASE_URL}/i/${guest.token}`,
    });
    const data = await api('/api/sendImage', {
      chatId: chatId(guest.phone),
      file: {
        mimetype: 'image/png',
        filename: `invite-${guest.token}.png`,
        data: png.toString('base64'),
      },
      caption,
    });
    imageId = idOf(data);
  } catch (err) {
    return { ok: false, error: errText(err), imageId: null, pollId: null, meta, caption };
  }

  await gap();

  try {
    const data = await api('/api/sendPoll', {
      chatId: chatId(guest.phone),
      poll: {
        name: 'تأكيد الحضور',
        options: options.map((o) => o.label),
        multipleAnswers: false,
      },
    });
    const pollId = idOf(data);
    meta.pollId = pollId;
    return { ok: true, error: null, imageId, pollId, meta, caption };
  } catch (pollErr) {
    // بديل: نص فيه رابط الرد (يعمل دائمًا حتى لو الميزة التفاعلية متوقفة)
    meta.interactive = 'text';
    meta.fallback = true;
    try {
      await api('/api/sendText', {
        chatId: chatId(guest.phone),
        text: caption,
        linkPreview: true,
      });
      return { ok: true, error: null, imageId, pollId: null, meta, caption };
    } catch (err) {
      return {
        ok: false,
        error: `${errText(pollErr)} — وتعذّر البديل النصي: ${errText(err)}`.slice(0, 300),
        imageId,
        pollId: null,
        meta,
        caption,
      };
    }
  }
}

async function sendText(phone, body) {
  try {
    const data = await api('/api/sendText', { chatId: chatId(phone), text: body, linkPreview: true });
    return { ok: true, error: null, extId: idOf(data) };
  } catch (err) {
    return { ok: false, error: errText(err), extId: null };
  }
}

// ───────── تسجيل الردود الواردة ─────────
function logInbound(guest, body, meta) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO outbox (guest_id, event_id, kind, to_phone, body, provider, channel, meta, source, ok)
     VALUES (?, ?, 'inbound', ?, ?, 'whatsapp-waha', 'whatsapp', ?, 'waha', 1)`,
  ).run(guest.id, guest.event_id, guest.phone, String(body || '').slice(0, 500), meta ? JSON.stringify(meta) : null);
  db.prepare('UPDATE guests SET last_inbound_at = ? WHERE id = ?').run(now, guest.id);
}

const AR_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;

function normalizeText(s) {
  return String(s || '')
    .replace(AR_DIACRITICS, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const YES = ['قبول', 'اقبل', 'أقبل', 'اؤكد', 'أؤكد', 'مؤكد', 'حاضر', 'نعم', 'yes', '1'];
const NO = ['اعتذار', 'اعتذر', 'أعتذر', 'معتذر', 'لن احضر', 'لن أحضر', 'no', '2'];
const LOC = ['موقع', 'الموقع', 'وين', 'العنوان', 'الخريطة', 'location', '3'];

function actionFromText(text) {
  const t = normalizeText(text);
  if (!t) return null;
  const has = (list) => list.some((w) => t === normalizeText(w) || t.includes(normalizeText(w)));
  if (has(YES)) return 'a';
  if (has(NO)) return 'd';
  if (has(LOC)) return 'l';
  return null;
}

/** آخر ضيف وصلته دعوة/تذكير على هذا الرقم */
function guestByPhone(phone) {
  return (
    db
      .prepare(
        `SELECT g.* FROM guests g
           JOIN outbox o ON o.guest_id = g.id
          WHERE g.phone = ? AND o.kind IN ('invite','reminder') AND o.ok = 1
          ORDER BY o.id DESC LIMIT 1`,
      )
      .get(phone) || null
  );
}

function actionForOption(row, option) {
  if (row && row.meta) {
    try {
      const meta = JSON.parse(row.meta);
      const hit = (meta.options || []).find((o) => o && o.label === option);
      if (hit && hit.action) return hit.action;
    } catch { /* meta غير صالح */ }
  }
  return actionFromText(option);
}

// ───────── Webhook ─────────
function verifyHmac(rawBody, header) {
  if (!cfg.WAHA_WEBHOOK_HMAC_KEY || !rawBody || !header) return false;
  const expected = crypto.createHmac('sha512', cfg.WAHA_WEBHOOK_HMAC_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function upsertStatus(body) {
  const p = body.payload || {};
  const me = body.me || {};
  const status = p.status || null;
  const phone = me.id ? String(me.id).split('@')[0] : null;
  db.prepare(
    `INSERT INTO wa_status (id, status, phone, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, phone = excluded.phone, updated_at = excluded.updated_at`,
  ).run(status, phone, new Date().toISOString());
  console.log(`[WAHA] حالة الجلسة: ${status}${phone ? ` (${phone})` : ''}`);
}

const ACK = { ERROR: 'failed', PENDING: 'sent', SERVER: 'sent', DEVICE: 'delivered', READ: 'read' };
const RANK = { sent: 1, delivered: 2, read: 3 };

function applyAck(p) {
  if (!p || !p.id) return;
  const status = ACK[String(p.ackName || '').toUpperCase()];
  if (!status) return;
  const row = db.prepare('SELECT * FROM outbox WHERE ext_id = ?').get(String(p.id));
  if (!row) return;
  if (status !== 'failed' && (RANK[row.delivery] || 0) >= RANK[status]) return;
  db.prepare('UPDATE outbox SET delivery = ? WHERE id = ?').run(status, row.id);
  if (!row.guest_id || (row.kind !== 'invite' && row.kind !== 'reminder')) return;
  const col = row.kind === 'invite' ? 'invite' : 'reminder';
  db.prepare(`UPDATE guests SET ${col}_delivery = ? WHERE id = ?`).run(status, row.guest_id);
  if (status === 'failed') {
    db.prepare(`UPDATE guests SET ${col}_state = 'failed', ${col}_error = ? WHERE id = ?`).run(
      'تعذّر تسليم الرسالة عبر واتساب', row.guest_id,
    );
  }
}

async function onMessage(body) {
  const p = body.payload || {};
  if (p.fromMe) return;
  const from = String(p.from || '');
  if (!/@c\.us$/.test(from)) return; // @lid مخفي — لا يمكن مطابقته برقم
  const phone = from.split('@')[0].replace(/\D/g, '');
  const guest = guestByPhone(phone);
  if (!guest) return;
  const text = String(p.body || '').trim();
  logInbound(guest, text || '(رسالة بدون نص)', { source: 'message', from });
  const action = actionFromText(text);
  if (!action) return;
  const whatsapp = require('./whatsapp');
  await whatsapp.handleButton(`${action}:${guest.token}`, phone);
}

async function onPollVote(body) {
  const p = body.payload || {};
  const vote = p.vote || {};
  const poll = p.poll || {};
  const rawFrom = vote.from || (poll.fromMe ? poll.to : poll.from) || '';
  const phone = String(rawFrom).split('@')[0].replace(/\D/g, '');
  const pollId = poll.id || null;
  const row = pollId ? db.prepare('SELECT * FROM outbox WHERE poll_ext_id = ? LIMIT 1').get(String(pollId)) : null;
  const guest = row && row.guest_id
    ? db.prepare('SELECT * FROM guests WHERE id = ?').get(row.guest_id)
    : guestByPhone(phone);
  if (!guest) return;
  // تصويت من رقم آخر: نتحقق فقط عندما يصل المعرّف بصيغة @c.us (أرقام @lid لا تُطابَق)
  if (/@c\.us$/.test(String(rawFrom)) && phone && String(guest.phone).replace(/\D/g, '') !== phone) return;
  const option = (vote.selectedOptions && vote.selectedOptions[0]) || '';
  logInbound(guest, option || 'تصويت', { source: 'poll', pollId, option });
  const action = actionForOption(row, option);
  if (!action) return;
  const whatsapp = require('./whatsapp');
  await whatsapp.handleButton(`${action}:${guest.token}`, phone);
}

/** معالجة حدث WAHA واحد. يرجع { duplicate: true } لو الحدث مكرر. */
async function processWebhook(body) {
  if (!body || !body.event) return { ignored: true };
  const id = body.id ? String(body.id) : null;
  if (id) {
    const r = db
      .prepare('INSERT OR IGNORE INTO webhook_events (id, provider, event) VALUES (?, ?, ?)')
      .run(id, 'waha', String(body.event));
    if (r.changes === 0) return { duplicate: true };
  }
  switch (body.event) {
    case 'session.status':
      upsertStatus(body);
      return { handled: true };
    case 'message.ack':
      applyAck(body.payload);
      return { handled: true };
    case 'message':
      await onMessage(body);
      return { handled: true };
    case 'poll.vote':
      await onPollVote(body);
      return { handled: true };
    default:
      return { ignored: true };
  }
}

function status() {
  const row = db.prepare('SELECT status, phone, updated_at FROM wa_status WHERE id = 1').get();
  return row
    ? { status: row.status, phone: row.phone, updatedAt: row.updated_at }
    : { status: 'unknown', phone: null, updatedAt: null };
}

/** فحص سريع لاتصال WAHA (يُستخدم في التشخيص) */
async function ping() {
  try {
    const res = await fetch(`${cfg.WAHA_BASE_URL}/api/sessions/${encodeURIComponent(SESSION())}`, {
      headers: cfg.WAHA_API_KEY ? { 'X-Api-Key': cfg.WAHA_API_KEY } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, status: data.status || null };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

module.exports = {
  chatId, idOf, sendInvite, sendText, processWebhook, verifyHmac, status, ping, captionFor,
  actionFromText, actionForOption,
};
