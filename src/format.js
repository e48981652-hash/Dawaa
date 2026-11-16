// تنسيق التاريخ والوقت بتوقيت الرياض (UTC+3 بدون توقيت صيفي)
const TZ = 'Asia/Riyadh';
const OFFSET_MS = 3 * 3600 * 1000;

const mk = (cal, opts) =>
  new Intl.DateTimeFormat(`ar-SA-u-ca-${cal}-nu-latn`, { timeZone: TZ, ...opts });

const fWeekday = mk('gregory', { weekday: 'long' });
const fGregorian = mk('gregory', { day: 'numeric', month: 'long', year: 'numeric' });
const fHijri = mk('islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' });
const fTime = mk('gregory', { hour: 'numeric', minute: '2-digit', hour12: true });

/** يرجع { date:'YYYY-MM-DD', time:'HH:mm' } بتوقيت الرياض */
function riyadhParts(iso) {
  const shifted = new Date(new Date(iso).getTime() + OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

/** يحوّل تاريخاً ووقتاً بتوقيت الرياض إلى ISO بتوقيت UTC، أو null إذا كانا غير صالحين */
function toStartsAt(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return null;
  const d = new Date(`${date}T${time}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function describe(iso) {
  const d = new Date(iso);
  return {
    weekday: fWeekday.format(d),
    gregorian: fGregorian.format(d),
    hijri: fHijri.format(d),
    time: fTime.format(d),
  };
}

/** 20.11.2026 */
function dotted(iso) {
  const { date } = riyadhParts(iso);
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

/** كم يوماً بين اليوم وتاريخ المناسبة بتوقيت الرياض (0 = اليوم، 1 = غداً) */
function daysUntil(iso, now = new Date()) {
  const day = (d) => Math.floor((d.getTime() + OFFSET_MS) / 86400000);
  return day(new Date(iso)) - day(now);
}

module.exports = { TZ, OFFSET_MS, riyadhParts, toStartsAt, describe, daysUntil, dotted };
