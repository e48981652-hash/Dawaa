// نصوص الرسائل (عربي). الرسالة العربية تُحسب بترميز UCS-2: 70 حرفاً للجزء الواحد، فالنص مختصر قدر الإمكان.
const { describe, daysUntil } = require('./format');

function inviteText(guest, event, url) {
  const d = describe(event.starts_at);
  const from = event.host_line ? ` من ${event.host_line}` : '';
  return [
    `السلام عليكم ${guest.name}`,
    `دعوة لحضور ${event.title}${from}`,
    `${d.weekday} ${d.gregorian} الساعة ${d.time}`,
    event.venue,
    `للرد على الدعوة: ${url}`,
  ].join('\n');
}

function reminderText(guest, event, url, now = new Date()) {
  const d = describe(event.starts_at);
  const n = daysUntil(event.starts_at, now);
  const when = n === 0 ? 'اليوم' : n === 1 ? 'غداً' : `${d.weekday} ${d.gregorian}`;
  return [
    `تذكير: ${event.title} ${when} الساعة ${d.time}`,
    event.venue,
    `نأمل تأكيد حضورك مرة ثانية: ${url}`,
  ].join('\n');
}

module.exports = { inviteText, reminderText };
