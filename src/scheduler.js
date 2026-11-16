// مجدول التذكير: قبل المناسبة بيوم، عند الساعة REMINDER_HOUR بتوقيت الرياض، يُرسل تذكير لطلب تأكيد الحضور.
// إذا أُنشئت المناسبة أو أُرسلت الدعوات بعد هذا الموعد، يُرسل التذكير في أول دورة تالية (مع تجاوز من وصلته الدعوة قبل أقل من 12 ساعة).
const db = require('./db');
const cfg = require('./env');
const { OFFSET_MS } = require('./format');
const { dispatchReminders } = require('./dispatch');
const { purgeExpiredSessions } = require('./auth');

/** لحظة إرسال التذكير: اليوم السابق ليوم المناسبة (بتوقيت الرياض) عند REMINDER_HOUR */
function reminderDueAt(startsAtIso) {
  const local = new Date(new Date(startsAtIso).getTime() + OFFSET_MS); // حقول UTC فيه = ساعة الرياض
  return new Date(Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 1, cfg.REMINDER_HOUR - OFFSET_MS / 3600000,
  ));
}

let running = false;

async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const horizon = new Date(now.getTime() + 72 * 3600 * 1000).toISOString();
    const events = db
      .prepare('SELECT * FROM events WHERE starts_at > ? AND starts_at <= ?')
      .all(now.toISOString(), horizon);
    for (const ev of events) {
      if (now >= reminderDueAt(ev.starts_at)) {
        const { queued, done } = dispatchReminders(ev.id, { respectRecentInvite: true });
        if (queued) {
          console.log(`[المجدول] تذكير لمناسبة #${ev.id}: ${queued} ضيف`);
          await done;
        }
      }
    }
  } catch (err) {
    console.error('[المجدول] خطأ:', err);
  } finally {
    running = false;
  }
}

function start() {
  // أي إرسال كان معلّقاً عند إيقاف السيرفر يرجع للطابور
  db.exec(`
    UPDATE guests SET invite_state = 'none'   WHERE invite_state = 'queued';
    UPDATE guests SET reminder_state = 'none' WHERE reminder_state = 'queued';
  `);
  purgeExpiredSessions();
  const timer = setInterval(() => tick(), cfg.SCHEDULER_INTERVAL_MS);
  timer.unref();
  setTimeout(() => tick(), 2000).unref();
  return timer;
}

module.exports = { start, tick, reminderDueAt };
