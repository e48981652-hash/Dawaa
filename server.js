const cfg = require('./src/env');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/db');
const { normalizePhone, displayPhone, parseBulk, parseCountry } = require('./src/phone');
const {
  hashPassword, verifyPassword, createSession, destroySession, requireAuth,
} = require('./src/auth');
const { describe, riyadhParts, toStartsAt } = require('./src/format');
const { dispatchInvites, dispatchReminders, linkFor } = require('./src/dispatch');
const scheduler = require('./src/scheduler');
const whatsapp = require('./src/whatsapp');
const waha = require('./src/waha');
const { renderCard } = require('./src/card');

// ذاكرة مؤقتة لصور البطاقات: renderCard ثقيل (SVG → PNG) ولا داعي لتكراره
// لنفس الضيف في كل فتح. المفتاح يتغيّر تلقائياً عند تعديل بيانات المناسبة.
const cardCache = new Map();
const CARD_CACHE_TTL_MS = 5 * 60 * 1000;
const CARD_CACHE_MAX = 300;
const QRCode = require('qrcode');
const { recordResponse } = require('./src/responses');
const { TEMPLATES, DEFAULT_TEMPLATE, isTemplate } = require('./src/templates');

const KINDS = ['wedding', 'engagement', 'newborn', 'graduation', 'other'];
const STATUSES = ['accepted', 'declined', 'maybe'];
const OCCASIONS = {
  wedding: 'حفل زفاف', engagement: 'حفل خطوبة', newborn: 'حفل استقبال مولود', graduation: 'حفل تخرج', other: 'مناسبة',
};
const HONORIFICS = ['m', 'f', ''];
const MAX_GUESTS_PER_EVENT = 2000;
const MAX_ROWS_PER_REQUEST = 500;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ───────── أدوات مساعدة ─────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) if (!arr.some((t) => now - t < windowMs)) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد دقائق' });
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: (r) => `auth:${r.ip}` });
const inviteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: (r) => `inv:${r.ip}:${r.params.token}` });

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

function ownedEvent(req) {
  const id = Number(req.params.id);
  const ev = Number.isInteger(id)
    ? db.prepare('SELECT * FROM events WHERE id = ? AND organizer_id = ?').get(id, req.org.id)
    : null;
  if (!ev) throw new HttpError(404, 'المناسبة غير موجودة');
  return ev;
}

function serializeEvent(ev) {
  const { date, time } = riyadhParts(ev.starts_at);
  return {
    id: ev.id,
    kind: ev.kind,
    template: ev.template,
    title: ev.title,
    occasion: ev.occasion || OCCASIONS[ev.kind] || OCCASIONS.other,
    honorees: ev.honorees,
    hostLine: ev.host_line,
    startsAt: ev.starts_at,
    date,
    time,
    display: describe(ev.starts_at),
    venue: ev.venue,
    mapUrl: ev.map_url,
    notes: ev.notes,
    allowCompanions: !!ev.allow_companions,
    maxCompanions: ev.max_companions,
    past: new Date(ev.starts_at) <= new Date(),
    reminder: (() => {
      const at = scheduler.reminderDueAt(ev.starts_at);
      return { at: at.toISOString(), passed: at <= new Date(), display: describe(at.toISOString()) };
    })(),
  };
}

function serializeGuest(g) {
  return {
    id: g.id,
    name: g.name,
    honorific: g.honorific,
    phone: g.phone,
    phoneDisplay: displayPhone(g.phone),
    status: g.status,
    companions: g.companions,
    respondedAt: g.responded_at,
    inviteState: g.invite_state,
    inviteSentAt: g.invite_sent_at,
    inviteError: g.invite_error,
    inviteDelivery: g.invite_delivery,
    reminderDelivery: g.reminder_delivery,
    reminderState: g.reminder_state,
    reminderSentAt: g.reminder_sent_at,
    reminderError: g.reminder_error,
    finalStatus: g.final_status,
    link: linkFor(g),
    cardUrl: whatsapp.cardUrl(g),
    qrUrl: `${cfg.PUBLIC_BASE_URL}/qr/${g.token}.svg`,
  };
}

function computeStats(guests) {
  const s = {
    total: guests.length, accepted: 0, declined: 0, maybe: 0, pending: 0,
    companions: 0, headcount: 0, invited: 0, reminded: 0, reconfirmed: 0, cancelledAfterReminder: 0,
  };
  for (const g of guests) {
    s[g.status] += 1;
    if (g.status === 'accepted') s.companions += g.companions;
    if (g.invite_state === 'sent') s.invited += 1;
    if (g.reminder_state === 'sent') s.reminded += 1;
    if (g.final_status === 'accepted') s.reconfirmed += 1;
    if (g.final_status === 'declined') s.cancelledAfterReminder += 1;
  }
  s.headcount = s.accepted + s.companions;
  return s;
}

function readEventInput(body, { creating }) {
  const venue = clean(body.venue, 200);
  const hostLine = clean(body.hostLine, 100);
  const notes = cleanMultiline(body.notes, 600);
  const kind = KINDS.includes(body.kind) ? body.kind : 'other';
  const template = isTemplate(body.template) ? body.template : DEFAULT_TEMPLATE;
  const mapUrl = clean(body.mapUrl, 500);
  const honorees = clean(body.honorees, 100);
  if (!hostLine) throw new HttpError(400, 'اكتب اسم صاحب الدعوة (مثل: عائلة العتيبي)');
  if (!honorees) throw new HttpError(400, 'اكتب أسماء أصحاب المناسبة (مثل: سلطان و ريم)');
  const occasion = clean(body.occasion, 60) || OCCASIONS[kind];
  const title = clean(body.title, 100) || `${occasion} ${honorees}`.slice(0, 100);
  if (!venue) throw new HttpError(400, 'اكتب مكان المناسبة');
  if (mapUrl && !/^https?:\/\/\S+$/i.test(mapUrl)) {
    throw new HttpError(400, 'رابط الموقع لازم يبدأ بـ https://');
  }
  const startsAt = toStartsAt(body.date, body.time);
  if (!startsAt) throw new HttpError(400, 'اختر تاريخ المناسبة ووقتها');
  if (creating && new Date(startsAt) <= new Date()) {
    throw new HttpError(400, 'موعد المناسبة لازم يكون في المستقبل');
  }
  const allow = body.allowCompanions === false || body.allowCompanions === 0 ? 0 : 1;
  // لو العميل لم يرسل maxCompanions (مثلاً إنشاء عبر API) نستخدم 2 بدل 0،
  // حتى لا تظهر دعوة «اسمح بالمرافقين» بلا أي خيارات في صفحة الضيف.
  const rawMax = body.maxCompanions;
  const max = rawMax === undefined || rawMax === null || rawMax === ''
    ? 2
    : Math.min(10, Math.max(0, parseInt(rawMax, 10) || 0));
  return { title, occasion, honorees, venue, hostLine, notes, kind, template, mapUrl, startsAt, allow, max: allow ? max : 0 };
}

function newToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// ───────── الوسائط العامة ─────────
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', // رابط الدعوة يحمل رمزاً خاصاً بالضيف
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ───────── الحساب ─────────
app.post('/api/auth/register', authLimiter, wrap((req, res) => {
  if (process.env.ALLOW_REGISTRATION === 'false') throw new HttpError(403, 'التسجيل مغلق حالياً');
  const name = clean(req.body.name, 60);
  const phone = normalizePhone(req.body.phone, parseCountry(req.body.country));
  const password = String(req.body.password || '');
  if (!name) throw new HttpError(400, 'اكتب اسمك');
  if (!phone) throw new HttpError(400, 'رقم الجوال غير صحيح');
  if (password.length < 8) throw new HttpError(400, 'كلمة المرور لازم تكون 8 خانات على الأقل');
  if (db.prepare('SELECT 1 FROM organizers WHERE phone = ?').get(phone)) {
    throw new HttpError(409, 'هذا الرقم مسجّل من قبل، سجّل دخولك');
  }
  const info = db
    .prepare('INSERT INTO organizers (name, phone, password_hash) VALUES (?, ?, ?)')
    .run(name, phone, hashPassword(password));
  const token = createSession(Number(info.lastInsertRowid));
  res.status(201).json({ token, user: { name, phone, phoneDisplay: displayPhone(phone) } });
}));

app.post('/api/auth/login', authLimiter, wrap((req, res) => {
  const phone = normalizePhone(req.body.phone, parseCountry(req.body.country));
  const password = String(req.body.password || '');
  const row = phone ? db.prepare('SELECT * FROM organizers WHERE phone = ?').get(phone) : null;
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, 'رقم الجوال أو كلمة المرور غير صحيحة');
  }
  const token = createSession(row.id);
  res.json({ token, user: { name: row.name, phone: row.phone, phoneDisplay: displayPhone(row.phone) } });
}));

app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(req.token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: { name: req.org.name, phone: req.org.phone, phoneDisplay: displayPhone(req.org.phone) },
    channel: cfg.INVITE_CHANNEL,
    whatsappMode: cfg.WHATSAPP_MODE,
    whatsappProblems: whatsapp.configProblems(),
    waStatus: cfg.INVITE_CHANNEL === 'whatsapp' ? waha.status() : null,
    demoMode: cfg.INVITE_CHANNEL === 'whatsapp' ? cfg.WHATSAPP_MODE === 'console' : cfg.SMS_PROVIDER === 'console',
  });
});

// حالة جلسة WAHA (لشارة الاتصال في الداشبورد)
app.get('/api/waha/status', requireAuth, wrap(async (req, res) => {
  const s = waha.status();
  const live = req.query.live === '1' ? await waha.ping() : null;
  res.json({
    ...s,
    live,
    mode: cfg.WHATSAPP_MODE,
    problems: whatsapp.configProblems(),
  });
}));

// ───────── القوالب ─────────
app.get('/api/templates', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ templates: TEMPLATES, default: DEFAULT_TEMPLATE });
});

// ───────── المناسبات ─────────
app.get('/api/events', requireAuth, (req, res) => {
  const events = db
    .prepare('SELECT * FROM events WHERE organizer_id = ? ORDER BY starts_at ASC')
    .all(req.org.id);
  const guests = db
    .prepare('SELECT * FROM guests WHERE event_id IN (SELECT id FROM events WHERE organizer_id = ?)')
    .all(req.org.id);
  const byEvent = new Map();
  for (const g of guests) {
    if (!byEvent.has(g.event_id)) byEvent.set(g.event_id, []);
    byEvent.get(g.event_id).push(g);
  }
  res.json({
    events: events.map((ev) => ({ ...serializeEvent(ev), stats: computeStats(byEvent.get(ev.id) || []) })),
  });
});

app.post('/api/events', requireAuth, (req, res) => {
  const v = readEventInput(req.body, { creating: true });
  const info = db
    .prepare(
      `INSERT INTO events (organizer_id, kind, template, title, occasion, honorees, host_line, starts_at, venue, map_url,
                           notes, allow_companions, max_companions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(req.org.id, v.kind, v.template, v.title, v.occasion, v.honorees, v.hostLine, v.startsAt, v.venue, v.mapUrl, v.notes, v.allow, v.max);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json({ event: serializeEvent(ev) });
});

app.get('/api/events/:id', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  const guests = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id ASC').all(ev.id);
  res.json({
    event: serializeEvent(ev),
    stats: computeStats(guests),
    guests: guests.map(serializeGuest),
    sending: guests.some((g) => g.invite_state === 'queued' || g.reminder_state === 'queued'),
  });
});

app.put('/api/events/:id', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  const v = readEventInput(req.body, { creating: false });
  db.prepare(
    `UPDATE events SET kind = ?, template = ?, title = ?, occasion = ?, honorees = ?, host_line = ?, starts_at = ?,
                       venue = ?, map_url = ?, notes = ?, allow_companions = ?, max_companions = ? WHERE id = ?`,
  ).run(v.kind, v.template, v.title, v.occasion, v.honorees, v.hostLine, v.startsAt, v.venue, v.mapUrl, v.notes, v.allow, v.max, ev.id);
  if (v.startsAt !== ev.starts_at) {
    // تغيّر الموعد: يُعاد جدولة التذكير ويُطلب تأكيد جديد
    db.prepare(
      `UPDATE guests SET reminder_state = 'none', reminder_sent_at = NULL, reminder_error = NULL,
                         final_status = NULL, final_at = NULL WHERE event_id = ?`,
    ).run(ev.id);
  }
  res.json({ event: serializeEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id)) });
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  db.prepare('DELETE FROM outbox WHERE event_id = ?').run(ev.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
  res.json({ ok: true });
});

// ───────── المعازيم ─────────
app.post('/api/events/:id/guests', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  let rows = [];
  const errors = [];

  if (typeof req.body.text === 'string') {
    const parsed = parseBulk(req.body.text, parseCountry(req.body.country));
    rows = parsed.rows;
    errors.push(...parsed.errors);
  } else if (Array.isArray(req.body.guests)) {
    for (const g of req.body.guests) {
      const phone = normalizePhone(g && g.phone, parseCountry(req.body.country));
      const name = clean(g && g.name, 80);
      if (!phone) errors.push({ line: `${name} ${g && g.phone ? g.phone : ''}`.trim(), reason: 'رقم الجوال غير صحيح' });
      else rows.push({ name: name || 'ضيف', phone, honorific: HONORIFICS.includes(g.honorific) ? g.honorific : null });
    }
  } else {
    throw new HttpError(400, 'أرسل قائمة المعازيم');
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    throw new HttpError(400, `الحد الأقصى ${MAX_ROWS_PER_REQUEST} ضيف في المرة الواحدة`);
  }

  const existing = db.prepare('SELECT COUNT(*) AS c FROM guests WHERE event_id = ?').get(ev.id).c;
  const batchHonorific = HONORIFICS.includes(req.body.honorific) ? req.body.honorific : '';
  const insert = db.prepare('INSERT INTO guests (event_id, name, phone, token, honorific) VALUES (?, ?, ?, ?, ?)');
  const seen = new Set(db.prepare('SELECT phone FROM guests WHERE event_id = ?').all(ev.id).map((g) => g.phone));
  let added = 0;
  const duplicates = [];

  db.transaction(() => {
    for (const r of rows) {
      if (seen.has(r.phone)) { duplicates.push(r); continue; }
      if (existing + added >= MAX_GUESTS_PER_EVENT) {
        errors.push({ line: `${r.name} ${r.phone}`, reason: `وصلت الحد الأقصى (${MAX_GUESTS_PER_EVENT} ضيف)` });
        continue;
      }
      insert.run(ev.id, r.name, r.phone, newToken(), r.honorific ?? batchHonorific);
      seen.add(r.phone);
      added += 1;
    }
  });
  res.status(201).json({
    added,
    duplicates: duplicates.map((d) => ({ name: d.name, phone: displayPhone(d.phone) })),
    errors,
  });
});

function ownedGuest(req) {
  const ev = ownedEvent(req);
  const gid = Number(req.params.gid);
  const g = Number.isInteger(gid)
    ? db.prepare('SELECT * FROM guests WHERE id = ? AND event_id = ?').get(gid, ev.id)
    : null;
  if (!g) throw new HttpError(404, 'الضيف غير موجود');
  return { ev, g };
}

app.put('/api/events/:id/guests/:gid', requireAuth, (req, res) => {
  const { ev, g } = ownedGuest(req);
  const name = clean(req.body.name, 80) || g.name;
  const honorific = HONORIFICS.includes(req.body.honorific) ? req.body.honorific : g.honorific;
  const phone = req.body.phone === undefined ? g.phone : normalizePhone(req.body.phone, parseCountry(req.body.country));
  if (!phone) throw new HttpError(400, 'رقم الجوال غير صحيح');
  if (phone !== g.phone) {
    if (db.prepare('SELECT 1 FROM guests WHERE event_id = ? AND phone = ? AND id != ?').get(ev.id, phone, g.id)) {
      throw new HttpError(409, 'هذا الرقم موجود في القائمة من قبل');
    }
    // رقم جديد: يُعاد إرسال الدعوة له
    db.prepare(
      `UPDATE guests SET name = ?, honorific = ?, phone = ?, invite_state = 'none', invite_sent_at = NULL,
                         invite_error = NULL, invite_delivery = NULL, reminder_state = 'none', reminder_sent_at = NULL,
                         reminder_error = NULL, reminder_delivery = NULL WHERE id = ?`,
    ).run(name, honorific, phone, g.id);
  } else {
    db.prepare('UPDATE guests SET name = ?, honorific = ? WHERE id = ?').run(name, honorific, g.id);
  }
  res.json({ guest: serializeGuest(db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id)) });
});

app.delete('/api/events/:id/guests/:gid', requireAuth, (req, res) => {
  const { g } = ownedGuest(req);
  db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
  res.json({ ok: true });
});

// ───────── إرسال الدعوات والتذكير ─────────
app.post('/api/events/:id/invite', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  if (new Date(ev.starts_at) <= new Date()) throw new HttpError(409, 'المناسبة انتهت');
  if (cfg.INVITE_CHANNEL === 'whatsapp') {
    const missing = whatsapp.missingForWhatsApp(ev);
    if (missing) throw new HttpError(409, missing);
  }
  const guestIds = Array.isArray(req.body.guestIds) ? req.body.guestIds : null;
  const { queued } = dispatchInvites(ev.id, { guestIds, resend: !!(guestIds && req.body.resend) });
  res.status(202).json({ queued });
});

app.post('/api/events/:id/remind', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  if (new Date(ev.starts_at) <= new Date()) throw new HttpError(409, 'المناسبة انتهت');
  const { queued } = dispatchReminders(ev.id, { includeFailed: true, resend: !!req.body.resend });
  res.status(202).json({ queued });
});

app.get('/api/events/:id/outbox', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  const rows = db
    .prepare(
      `SELECT o.id, o.kind, o.to_phone, o.body, o.ok, o.error, o.created_at, o.channel, o.meta, o.delivery,
              o.source, o.guest_id, g.name AS guest_name
         FROM outbox o LEFT JOIN guests g ON g.id = o.guest_id
        WHERE o.event_id = ? ORDER BY o.id DESC LIMIT 100`,
    )
    .all(ev.id);
  res.json({
    provider: cfg.INVITE_CHANNEL === 'whatsapp' ? `whatsapp-${cfg.WHATSAPP_MODE}` : cfg.SMS_PROVIDER,
    simulate: cfg.INVITE_CHANNEL === 'whatsapp' && cfg.WHATSAPP_MODE === 'console',
    messages: rows.map((r) => {
      let meta = null;
      try { meta = r.meta ? JSON.parse(r.meta) : null; } catch { /* تجاهل */ }
      return {
        id: r.id, kind: r.kind, channel: r.channel, source: r.source, guestId: r.guest_id, guestName: r.guest_name,
        phone: displayPhone(r.to_phone), body: r.body, ok: !!r.ok, error: r.error, createdAt: r.created_at,
        delivery: r.delivery, image: meta && meta.image, buttons: meta && meta.buttons,
        interactive: meta && meta.interactive, options: meta && meta.options,
      };
    }),
  });
});

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // حماية من حقن الصيغ في Excel
  return `"${s.replace(/"/g, '""')}"`;
}

app.get('/api/events/:id/export.csv', requireAuth, (req, res) => {
  const ev = ownedEvent(req);
  const label = { accepted: 'حاضر', declined: 'معتذر', maybe: 'ربما', pending: 'لم يرد' };
  const final = { accepted: 'أكّد الحضور', declined: 'اعتذر', maybe: 'ربما' };
  const head = ['الاسم', 'الجوال', 'الحالة', 'المرافقون', 'إجمالي الحضور', 'الرد بعد التذكير'];
  const lines = [head.map(csvCell).join(',')];
  for (const g of db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id').all(ev.id)) {
    lines.push([
      g.name, displayPhone(g.phone), label[g.status],
      g.status === 'accepted' ? g.companions : 0,
      g.status === 'accepted' ? 1 + g.companions : 0,
      g.final_status ? final[g.final_status] : '',
    ].map(csvCell).join(','));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="guests-${ev.id}.csv"`,
  });
  res.send('﻿' + lines.join('\r\n'));
});

// ───────── صفحة الضيف (عامة، بالرمز الخاص) ─────────
function findByToken(token) {
  const g = db.prepare('SELECT * FROM guests WHERE token = ?').get(String(token));
  if (!g) throw new HttpError(404, 'رابط الدعوة غير صحيح');
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(g.event_id);
  return { g, ev };
}

app.get('/api/invite/:token', inviteLimiter, (req, res) => {
  const { g, ev } = findByToken(req.params.token);
  const e = serializeEvent(ev);
  res.json({
    guest: { name: g.name, honorific: g.honorific, status: g.status, companions: g.companions },
    qrUrl: `${cfg.PUBLIC_BASE_URL}/qr/${g.token}.svg`,
    mode: g.reminder_sent_at && !g.final_status ? 'reminder' : 'invite',
    closed: e.past,
    event: {
      kind: e.kind, template: e.template, title: e.title, occasion: e.occasion, honorees: e.honorees, hostLine: e.hostLine, startsAt: e.startsAt, display: e.display, venue: e.venue,
      mapUrl: e.mapUrl, notes: e.notes, allowCompanions: e.allowCompanions, maxCompanions: e.maxCompanions,
    },
  });
});

app.post('/api/invite/:token/respond', inviteLimiter, (req, res) => {
  const { g, ev } = findByToken(req.params.token);
  if (new Date(ev.starts_at) <= new Date()) throw new HttpError(409, 'انتهت المناسبة');
  const status = req.body.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'اختر ردّك على الدعوة');
  let companions = 0;
  if (status === 'accepted' && ev.allow_companions) {
    companions = Math.min(ev.max_companions, Math.max(0, parseInt(req.body.companions, 10) || 0));
  }
  recordResponse(g, ev, status, companions);
  res.json({ ok: true, guest: { status, companions } });
});

// ───────── بطاقة الدعوة ورمز QR (عامة، بالرمز الخاص بالضيف) ─────────
const inviteUrl = (g) => `${cfg.PUBLIC_BASE_URL}/i/${g.token}`;

app.get('/card/:token.png', inviteLimiter, (req, res) => {
  const { g, ev } = findByToken(req.params.token);
  const e = serializeEvent(ev);
  const key = [g.token, g.name, ev.template, ev.honorees, ev.host_line, ev.starts_at, ev.venue].join('|');
  const hit = cardCache.get(key);
  let png;
  if (hit && hit.exp > Date.now()) {
    png = hit.png;
  } else {
    png = renderCard({
      template: ev.template, occasion: e.occasion, host: ev.host_line, honorees: ev.honorees,
      startsAt: ev.starts_at, venue: ev.venue, qrUrl: inviteUrl(g),
    });
    cardCache.set(key, { png, exp: Date.now() + CARD_CACHE_TTL_MS });
    if (cardCache.size > CARD_CACHE_MAX) cardCache.delete(cardCache.keys().next().value);
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
  res.send(png);
});

app.get('/qr/:token.svg', inviteLimiter, wrap(async (req, res) => {
  const { g } = findByToken(req.params.token);
  const svg = await QRCode.toString(inviteUrl(g), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
  res.send(svg);
}));

// ───────── WAHA: Webhook ─────────
// WAHA يوقّع كل طلب بـ HMAC-SHA512 على الجسم الخام في ترويسة X-Webhook-Hmac.
// نرد 200 فوراً ثم نعالج في الخلفية حتى لا يعيد WAHA المحاولة عند بطء المعالجة.
app.post('/webhooks/waha', wrap(async (req, res) => {
  if (!waha.verifyHmac(req.rawBody, req.get('x-webhook-hmac'))) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    await waha.processWebhook(req.body);
  } catch (err) {
    console.error('[WAHA] خطأ في معالجة الـ Webhook:', err);
  }
}));

// وضع التجربة: محاكاة ضغط الضيف على أحد أزرار الرسالة (نفس مسار الـ Webhook الحقيقي)
app.post('/api/events/:id/guests/:gid/simulate', requireAuth, wrap(async (req, res) => {
  const { g } = ownedGuest(req);
  if (!(cfg.INVITE_CHANNEL === 'whatsapp' && cfg.WHATSAPP_MODE === 'console')) {
    throw new HttpError(404, 'المحاكاة متاحة في الوضع التجريبي فقط');
  }
  const action = ['a', 'd', 'l'].includes(req.body.action) ? req.body.action : null;
  if (!action) throw new HttpError(400, 'زر غير معروف');
  const r = await whatsapp.handleButton(`${action}:${g.token}`, g.phone);
  const fresh = db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id);
  res.json({ ok: !!r.handled, reply: r.reply ? r.reply.body : null, guest: serializeGuest(fresh) });
}));

// ───────── الملفات الثابتة ─────────
app.get('/i/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'بيانات غير صالحة' });
  console.error(err);
  res.status(500).json({ error: 'صار خطأ في السيرفر، حاول مرة ثانية' });
});

function start() {
  scheduler.start();
  return app.listen(cfg.PORT, () => {
    const channel = cfg.INVITE_CHANNEL === 'whatsapp'
      ? `واتساب/${cfg.WHATSAPP_MODE}${cfg.WHATSAPP_MODE === 'waha' ? ` · WAHA: ${cfg.WAHA_BASE_URL}` : ''}`
      : `SMS/${cfg.SMS_PROVIDER}`;
    console.log(`حيّاك يعمل على ${cfg.PUBLIC_BASE_URL} (القناة: ${channel})`);
  });
}

if (require.main === module) start();
module.exports = { app, start };
