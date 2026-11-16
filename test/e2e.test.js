// اختبار شامل للتدفق: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hayyak-test-'));
process.env.SMS_PROVIDER = 'console';
process.env.INVITE_CHANNEL = 'sms';
process.env.SCHEDULER_INTERVAL_MS = '300';
process.env.REMINDER_HOUR = '10';
process.env.PORT = '0';
process.env.PUBLIC_BASE_URL = 'http://test.local';

const db = require('../src/db');
const { start } = require('../server');
const { normalizePhone, parseBulk } = require('../src/phone');
const { reminderDueAt } = require('../src/scheduler');
const { riyadhParts } = require('../src/format');

let server;
let base;
let token;
let eventId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, tok = token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ليس JSON */ }
  return { status: res.status, json, text };
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

test.before(async () => {
  server = start();
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('تطبيع أرقام الجوال', () => {
  assert.equal(normalizePhone('0501234567'), '966501234567');
  assert.equal(normalizePhone('501234567'), '966501234567');
  assert.equal(normalizePhone('+966 50 123 4567'), '966501234567');
  assert.equal(normalizePhone('00966501234567'), '966501234567');
  assert.equal(normalizePhone('٠٥٠١٢٣٤٥٦٧'), '966501234567');
  assert.equal(normalizePhone('+9660501234567'), '966501234567');
  assert.equal(normalizePhone('+201001234567'), '201001234567'); // رقم مصري صريح
  assert.equal(normalizePhone('0112345678'), '966112345678'); // أرضي سعودي مقبول
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('أرقام أي دولة في العالم', () => {
  // بدون دولة مختارة: الرقم لازم يبدأ بـ + أو 00
  assert.equal(normalizePhone('01012345678', ''), null);
  assert.equal(normalizePhone('+20 101 234 5678', ''), '201012345678');
  assert.equal(normalizePhone('0044 7911 123456', ''), '447911123456');
  // مع دولة مختارة: الصفر الأول يُحذف ويُضاف رمز الدولة
  assert.equal(normalizePhone('01012345678', '20'), '201012345678'); // مصر
  assert.equal(normalizePhone('1012345678', '20'), '201012345678');
  assert.equal(normalizePhone('201012345678', '20'), '201012345678'); // فيه رمز الدولة أصلاً
  assert.equal(normalizePhone('+2001012345678', '20'), '201012345678'); // صفر زائد بعد الرمز
  assert.equal(normalizePhone('07911 123456', '44'), '447911123456'); // بريطانيا
  assert.equal(normalizePhone('(415) 555-2671', '1'), '14155552671'); // أمريكا
  assert.equal(normalizePhone('0171 1234567', '49'), '491711234567'); // ألمانيا
  // الأسطر الباطلة
  assert.equal(normalizePhone('123', '20'), null);
  assert.equal(normalizePhone('+1234567890123456', ''), null); // أطول من 15 رقماً
});

test('تحليل القائمة الملصوقة', () => {
  const { rows, errors } = parseBulk('محمد العتيبي، 0501234567\n0551112233 سارة\n٠٥٦٠٠٠٠٠٠٠ خالد\nبدون رقم\n0123');
  assert.deepEqual(rows.map((r) => r.name), ['محمد العتيبي', 'سارة', 'خالد']);
  assert.deepEqual(rows.map((r) => r.phone), ['966501234567', '966551112233', '966560000000']);
  assert.equal(errors.length, 2);
  const mixed = parseBulk('علي 01012345678\nجون +44 7911 123456\nسارة 0501234567', '20');
  assert.deepEqual(mixed.rows.map((r) => r.phone), ['201012345678', '447911123456', '20501234567']);
});

test('موعد التذكير: اليوم السابق 10 صباحاً بتوقيت الرياض', () => {
  // مناسبة الخميس 2026-12-10 الساعة 20:30 بالرياض → التذكير الأربعاء 2026-12-09 الساعة 10:00 بالرياض = 07:00 UTC
  const due = reminderDueAt('2026-12-10T17:30:00.000Z');
  assert.equal(due.toISOString(), '2026-12-09T07:00:00.000Z');
  assert.deepEqual(riyadhParts('2026-12-10T17:30:00.000Z'), { date: '2026-12-10', time: '20:30' });
});

test('الحماية: كل شيء يحتاج تسجيل دخول', async () => {
  assert.equal((await api('GET', '/api/events', null, '')).status, 401);
  assert.equal((await api('GET', '/api/events', null, 'bogus')).status, 401);
});

test('تسجيل منظّم ودخوله', async () => {
  const bad = await api('POST', '/api/auth/register', { name: 'أحمد', phone: '12', password: 'password1' }, '');
  assert.equal(bad.status, 400);
  const weak = await api('POST', '/api/auth/register', { name: 'أحمد', phone: '0501234567', password: '123' }, '');
  assert.equal(weak.status, 400);
  const ok = await api('POST', '/api/auth/register', { name: 'أحمد', phone: '0501234567', password: 'password1' }, '');
  assert.equal(ok.status, 201);
  const dup = await api('POST', '/api/auth/register', { name: 'أحمد', phone: '966501234567', password: 'password1' }, '');
  assert.equal(dup.status, 409);
  const wrong = await api('POST', '/api/auth/login', { phone: '0501234567', password: 'nope-nope' }, '');
  assert.equal(wrong.status, 401);
  const login = await api('POST', '/api/auth/login', { phone: '٠٥٠١٢٣٤٥٦٧', password: 'password1' }, '');
  assert.equal(login.status, 200);
  token = login.json.token;
});

test('إنشاء مناسبة والتحقق من المدخلات', async () => {
  const past = await api('POST', '/api/events', {
    title: 'حفل', hostLine: 'أبو خالد', honorees: 'خالد', venue: 'قاعة', date: '2020-01-01', time: '20:00',
  });
  assert.equal(past.status, 400);
  const badLink = await api('POST', '/api/events', {
    title: 'حفل', hostLine: 'أبو خالد', honorees: 'خالد', venue: 'قاعة', date: '2099-01-01', time: '20:00', mapUrl: 'javascript:alert(1)',
  });
  assert.equal(badLink.status, 400);

  // مناسبة بعد 20 ساعة من الآن => موعد التذكير مضى فيُرسل التذكير في أول دورة للمجدول
  const when = riyadhParts(new Date(Date.now() + 20 * 3600 * 1000).toISOString());
  const res = await api('POST', '/api/events', {
    kind: 'wedding', template: 'rose', title: 'حفل زواج خالد وسارة', honorees: 'خالد وسارة', hostLine: 'عائلة العتيبي', venue: 'قاعة الواحة - الرياض',
    mapUrl: 'https://maps.google.com/?q=riyadh', date: when.date, time: when.time,
    allowCompanions: true, maxCompanions: 2, notes: 'الحضور بعد صلاة العشاء',
  });
  assert.equal(res.status, 201, res.text);
  eventId = res.json.event.id;
  assert.equal(res.json.event.display.hijri.length > 0, true);
  assert.equal(res.json.event.template, 'rose');
});

test('القوالب: عشرة قوالب، وقالب غير معروف يرجع للافتراضي', async () => {
  const list = (await api('GET', '/api/templates', null, '')).json;
  assert.equal(list.templates.length, 10);
  assert.equal(new Set(list.templates.map((t) => t.id)).size, 10);
  assert.ok(list.templates.every((t) => t.label && t.note));
  assert.equal(list.default, 'najd');

  // كل قالب له قواعد في themes.css
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'themes.css'), 'utf8');
  for (const t of list.templates) assert.ok(css.includes(`[data-theme="${t.id}"]`), `قالب ${t.id} ناقص في themes.css`);

  const when = riyadhParts(new Date(Date.now() + 9 * 86400000).toISOString());
  const base = { title: 'مناسبة', hostLine: 'عائلة', honorees: 'خالد', venue: 'قاعة', date: when.date, time: when.time };
  const bad = await api('POST', '/api/events', { ...base, template: '"><script>alert(1)</script>' });
  assert.equal(bad.status, 201);
  assert.equal(bad.json.event.template, 'najd');
  const none = await api('POST', '/api/events', base);
  assert.equal(none.json.event.template, 'najd');
  const royal = await api('POST', '/api/events', { ...base, template: 'royal' });
  assert.equal(royal.json.event.template, 'royal');
  const edited = await api('PUT', `/api/events/${royal.json.event.id}`, { ...base, template: 'sea' });
  assert.equal(edited.json.event.template, 'sea');
  for (const e of [bad, none, royal]) await api('DELETE', `/api/events/${e.json.event.id}`);
});

test('إضافة المعازيم: صيغ مختلفة وتكرار وأخطاء', async () => {
  const res = await api('POST', `/api/events/${eventId}/guests`, {
    text: [
      'محمد العتيبي، 0501111111',
      '0502222222 سارة الغامدي',
      '٠٥٠٣٣٣٣٣٣٣ نورة',
      '+966 50 444 4444 فهد',
      '0501111111 محمد مكرر',
      'سطر بلا رقم',
    ].join('\n'),
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.added, 4);
  assert.equal(res.json.duplicates.length, 1);
  assert.equal(res.json.errors.length, 1);
});

let guests;
test('إرسال الدعوات في الخلفية', async () => {
  const res = await api('POST', `/api/events/${eventId}/invite`, {});
  assert.equal(res.status, 202);
  assert.equal(res.json.queued, 4);
  const ok = await waitFor(async () => {
    const d = (await api('GET', `/api/events/${eventId}`)).json;
    return d.guests.every((g) => g.inviteState === 'sent');
  });
  assert.ok(ok, 'لم تكتمل الدعوات');
  guests = (await api('GET', `/api/events/${eventId}`)).json.guests;

  const outbox = (await api('GET', `/api/events/${eventId}/outbox`)).json;
  assert.equal(outbox.messages.length, 4);
  const msg = outbox.messages.find((m) => m.guestName === 'سارة الغامدي');
  assert.match(msg.body, /http:\/\/test\.local\/i\//);
  assert.match(msg.body, /حفل زواج خالد وسارة/);

  // لا تُعاد الدعوة لمن وصلته
  const again = await api('POST', `/api/events/${eventId}/invite`, {});
  assert.equal(again.json.queued, 0);
});

test('صفحة الضيف: الرد على الدعوة', async () => {
  const sara = guests.find((g) => g.name === 'سارة الغامدي');
  const tok = sara.link.split('/i/')[1];

  assert.equal((await api('GET', '/api/invite/nope', null, '')).status, 404);
  const view = await api('GET', `/api/invite/${tok}`, null, '');
  assert.equal(view.status, 200);
  assert.equal(view.json.mode, 'invite');
  assert.equal(view.json.guest.status, 'pending');
  assert.equal(view.json.event.hostLine, 'عائلة العتيبي');
  assert.equal(view.json.event.template, 'rose');
  assert.equal('phone' in view.json.guest, false); // لا نكشف الأرقام للضيف

  assert.equal((await api('POST', `/api/invite/${tok}/respond`, { status: 'pending' }, '')).status, 400);
  const r = await api('POST', `/api/invite/${tok}/respond`, { status: 'accepted', companions: 9 }, '');
  assert.equal(r.status, 200);
  assert.equal(r.json.guest.companions, 2); // يُقصّ للحد الأقصى

  const fahd = guests.find((g) => g.name === 'فهد');
  const r2 = await api('POST', `/api/invite/${fahd.link.split('/i/')[1]}/respond`, { status: 'declined', companions: 3 }, '');
  assert.equal(r2.json.guest.companions, 0);

  const mohammed = guests.find((g) => g.name === 'محمد العتيبي');
  await api('POST', `/api/invite/${mohammed.link.split('/i/')[1]}/respond`, { status: 'maybe' }, '');
});

test('التذكير التلقائي: يصل لمن لم يعتذر فقط، ويتجاوز من وصلته الدعوة قبل أقل من 12 ساعة', async () => {
  // الدعوات أُرسلت الآن => يتجاوزها المجدول. نقدّم وقت إرسالها 13 ساعة للخلف.
  await sleep(700); // دورتان للمجدول
  let d = (await api('GET', `/api/events/${eventId}`)).json;
  assert.ok(d.guests.every((g) => g.reminderState === 'none'), 'لا تذكير قبل مرور 12 ساعة على الدعوة');

  const past = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  db.prepare('UPDATE guests SET invite_sent_at = ? WHERE event_id = ?').run(past, eventId);

  const ok = await waitFor(async () => {
    d = (await api('GET', `/api/events/${eventId}`)).json;
    return d.guests.filter((g) => g.reminderState === 'sent').length === 3;
  });
  assert.ok(ok, 'لم يصل التذكير');
  assert.equal(d.guests.find((g) => g.name === 'فهد').reminderState, 'none'); // المعتذر لا يُذكَّر

  const outbox = (await api('GET', `/api/events/${eventId}/outbox`)).json;
  const reminders = outbox.messages.filter((m) => m.kind === 'reminder');
  assert.equal(reminders.length, 3);
  assert.match(reminders[0].body, /تأكيد حضورك/);
  assert.match(reminders[0].body, /غداً|اليوم/);

  // لا تكرار في الدورات التالية
  await sleep(800);
  const again = (await api('GET', `/api/events/${eventId}/outbox`)).json;
  assert.equal(again.messages.filter((m) => m.kind === 'reminder').length, 3);
});

test('إعادة التأكيد بعد التذكير', async () => {
  d = (await api('GET', `/api/events/${eventId}`)).json;
  const sara = d.guests.find((g) => g.name === 'سارة الغامدي');
  const tok = sara.link.split('/i/')[1];

  const view = await api('GET', `/api/invite/${tok}`, null, '');
  assert.equal(view.json.mode, 'reminder');

  const r = await api('POST', `/api/invite/${tok}/respond`, { status: 'accepted', companions: 1 }, '');
  assert.equal(r.status, 200);
  assert.equal((await api('GET', `/api/invite/${tok}`, null, '')).json.mode, 'invite'); // أجاب بعد التذكير

  const mohammed = d.guests.find((g) => g.name === 'محمد العتيبي');
  await api('POST', `/api/invite/${mohammed.link.split('/i/')[1]}/respond`, { status: 'declined' }, '');

  d = (await api('GET', `/api/events/${eventId}`)).json;
  assert.equal(d.stats.accepted, 1);
  assert.equal(d.stats.companions, 1);
  assert.equal(d.stats.headcount, 2);
  assert.equal(d.stats.declined, 2);
  assert.equal(d.stats.reconfirmed, 1);
  assert.equal(d.stats.cancelledAfterReminder, 1);
});

test('تصدير CSV', async () => {
  const res = await api('GET', `/api/events/${eventId}/export.csv`);
  assert.equal(res.status, 200);
  // fetch().text() يحذف علامة BOM تلقائياً، فنفحص البايتات الخام (EF BB BF) كي يفتح Excel العربية بشكل صحيح
  const raw = Buffer.from(
    await (await fetch(`${base}/api/events/${eventId}/export.csv`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer(),
  );
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(res.text, /سارة الغامدي/);
  assert.match(res.text, /أكّد الحضور/);
});

test('عزل البيانات بين المنظّمين', async () => {
  const other = await api('POST', '/api/auth/register', { name: 'ثاني', phone: '0559999999', password: 'password2' }, '');
  const t2 = other.json.token;
  assert.equal((await api('GET', `/api/events/${eventId}`, null, t2)).status, 404);
  assert.equal((await api('DELETE', `/api/events/${eventId}`, null, t2)).status, 404);
  assert.equal((await api('POST', `/api/events/${eventId}/invite`, {}, t2)).status, 404);
  assert.equal((await api('GET', '/api/events', null, t2)).json.events.length, 0);
});

test('تعديل موعد المناسبة يعيد جدولة التذكير', async () => {
  const when = riyadhParts(new Date(Date.now() + 5 * 86400000).toISOString());
  const ev = (await api('GET', `/api/events/${eventId}`)).json.event;
  const res = await api('PUT', `/api/events/${eventId}`, { ...ev, date: when.date, time: when.time });
  assert.equal(res.status, 200, res.text);
  const d = (await api('GET', `/api/events/${eventId}`)).json;
  assert.ok(d.guests.every((g) => g.reminderState === 'none' && g.finalStatus === null));
});

test('حذف ضيف ومناسبة', async () => {
  const d = (await api('GET', `/api/events/${eventId}`)).json;
  assert.equal((await api('DELETE', `/api/events/${eventId}/guests/${d.guests[0].id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/events/${eventId}`)).status, 200);
  assert.equal((await api('GET', `/api/events/${eventId}`)).status, 404);
});

test('الترويسات الأمنية', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
});
