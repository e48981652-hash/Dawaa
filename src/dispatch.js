// إرسال الدعوات والتذكيرات. الإرسال يتم في الخلفية والواجهة تتابع حالة كل ضيف (queued → sent/failed).
const db = require('./db');
const cfg = require('./env');
const sms = require('./sms');
const whatsapp = require('./whatsapp');
const { inviteText, reminderText } = require('./messages');

const CONCURRENCY = 5;
const RECENT_INVITE_MS = 12 * 3600 * 1000;

const linkFor = (guest) => `${cfg.PUBLIC_BASE_URL}/i/${guest.token}`;

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        console.error('خطأ غير متوقع أثناء الإرسال:', err);
      }
    }
  });
  await Promise.all(runners);
}

/** إرسال رسالة واحدة عبر القناة المضبوطة (واتساب أو SMS). يرجع { ok, error } */
function deliver(kind, guest, event) {
  if (cfg.INVITE_CHANNEL === 'whatsapp') return whatsapp.sendTemplate(kind, guest, event);
  const body = kind === 'invite' ? inviteText(guest, event, linkFor(guest)) : reminderText(guest, event, linkFor(guest));
  return sms.send({ guestId: guest.id, eventId: event.id, kind, to: guest.phone, body });
}

function loadEvent(eventId) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
}

/** يضع الدعوات في الطابور. يرجع { queued, done } حيث done وعد ينتهي عند اكتمال الإرسال. */
function dispatchInvites(eventId, { guestIds = null, resend = false } = {}) {
  const event = loadEvent(eventId);
  if (!event) return { queued: 0, done: Promise.resolve() };

  let guests = db.prepare('SELECT * FROM guests WHERE event_id = ?').all(eventId);
  if (guestIds) {
    const wanted = new Set(guestIds.map(Number));
    guests = guests.filter((g) => wanted.has(g.id));
  }
  guests = guests.filter(
    (g) => g.invite_state !== 'queued' && (resend || g.invite_state === 'none' || g.invite_state === 'failed'),
  );

  const mark = db.prepare("UPDATE guests SET invite_state = 'queued', invite_error = NULL, invite_delivery = NULL WHERE id = ?");
  for (const g of guests) mark.run(g.id);

  const ok = db.prepare("UPDATE guests SET invite_state = 'sent', invite_sent_at = ?, invite_error = NULL WHERE id = ?");
  const fail = db.prepare("UPDATE guests SET invite_state = 'failed', invite_error = ? WHERE id = ?");

  const done = pool(guests, CONCURRENCY, async (g) => {
    const r = await deliver('invite', g, event);
    if (r.ok) ok.run(new Date().toISOString(), g.id);
    else fail.run(r.error, g.id);
  });
  return { queued: guests.length, done };
}

/**
 * يضع التذكيرات في الطابور للضيوف الذين وصلتهم الدعوة ولم يعتذروا.
 *  - respectRecentInvite: يتجاوز من وصلته الدعوة قبل أقل من 12 ساعة (يستخدمه المجدول)
 *  - includeFailed: يعيد المحاولة مع من فشل تذكيرهم سابقاً
 *  - resend: يعيد الإرسال حتى لمن وصله التذكير
 */
function dispatchReminders(eventId, { respectRecentInvite = false, includeFailed = false, resend = false } = {}) {
  const event = loadEvent(eventId);
  if (!event) return { queued: 0, done: Promise.resolve() };
  const now = Date.now();

  const guests = db
    .prepare('SELECT * FROM guests WHERE event_id = ?')
    .all(eventId)
    .filter((g) => {
      if (g.invite_state !== 'sent' || g.status === 'declined') return false;
      if (g.reminder_state === 'queued') return false;
      if (respectRecentInvite && g.invite_sent_at && now - new Date(g.invite_sent_at).getTime() < RECENT_INVITE_MS) {
        return false;
      }
      if (g.reminder_state === 'none') return true;
      if (g.reminder_state === 'failed') return includeFailed || resend;
      return resend; // sent
    });

  const mark = db.prepare("UPDATE guests SET reminder_state = 'queued', reminder_error = NULL, reminder_delivery = NULL WHERE id = ?");
  for (const g of guests) mark.run(g.id);

  const ok = db.prepare("UPDATE guests SET reminder_state = 'sent', reminder_sent_at = ?, reminder_error = NULL WHERE id = ?");
  const fail = db.prepare("UPDATE guests SET reminder_state = 'failed', reminder_error = ? WHERE id = ?");

  const done = pool(guests, CONCURRENCY, async (g) => {
    const r = await deliver('reminder', g, event);
    if (r.ok) ok.run(new Date().toISOString(), g.id);
    else fail.run(r.error, g.id);
  });
  return { queued: guests.length, done };
}

module.exports = { dispatchInvites, dispatchReminders, linkFor };
