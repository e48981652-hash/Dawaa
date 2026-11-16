// تسجيل ردّ الضيف (من صفحة الدعوة أو من أزرار واتساب) في مكان واحد.
const db = require('./db');

function recordResponse(guest, event, status, companions = 0) {
  const now = new Date().toISOString();
  const afterReminder = !!guest.reminder_sent_at; // الرد بعد وصول التذكير يُسجَّل كتأكيد نهائي
  db.prepare(
    `UPDATE guests SET status = ?, companions = ?, responded_at = ?,
                       final_status = ?, final_at = ? WHERE id = ?`,
  ).run(status, companions, now, afterReminder ? status : guest.final_status, afterReminder ? now : guest.final_at, guest.id);
}

module.exports = { recordResponse };
