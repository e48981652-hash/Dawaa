// واتساب: الرسالة والأزرار والـ Webhook وبطاقة الدعوة. node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hayyak-wa-'));
process.env.INVITE_CHANNEL = 'whatsapp';
process.env.WHATSAPP_MODE = 'console';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_APP_SECRET = 'app-secret';
process.env.SCHEDULER_INTERVAL_MS = '3600000';
process.env.PORT = '0';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const cfg = require('../src/env');
const db = require('../src/db');
const { start } = require('../server');
const wa = require('../src/whatsapp');

let server;
let base;
let token;
let eventId;
let guests;

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ليس JSON */ }
  return { status: res.status, json, text };
}

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
async function webhook(payload, { signed = true } = {}) {
  const raw = JSON.stringify(payload);
  return fetch(base + '/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signed ? { 'X-Hub-Signature-256': sign(raw) } : {}) },
    body: raw,
  });
}
const buttonMsg = (from, payload) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ from, type: 'button', button: { payload, text: 'x' } }] } }] }],
});
const statusMsg = (id, status, errors) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { statuses: [{ id, status, ...(errors ? { errors } : {}) }] } }] }],
});
const guestRow = (id) => db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test.before(async () => {
  server = start();
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await api('POST', '/api/auth/register', { name: 'منظم', phone: '0501111111', password: 'password123' });
  token = r.json.token;
  const d = new Date(Date.now() + 10 * 86400000 + 3 * 3600000).toISOString();
  const ev = await api('POST', '/api/events', {
    kind: 'wedding', template: 'rose', hostLine: 'عائلة العتيبي', honorees: 'سلطان و ريم',
    venue: 'فندق فيرست جراند', mapUrl: 'https://maps.example/abc', date: d.slice(0, 10), time: '20:30',
  });
  assert.equal(ev.status, 201, ev.text);
  eventId = ev.json.event.id;
  assert.equal(ev.json.event.occasion, 'حفل زفاف');
  const add = await api('POST', `/api/events/${eventId}/guests`, { text: 'ريم القصيبي 0502222222\nفهد 0503333333', honorific: 'f' });
  assert.equal(add.json.added, 2);
  guests = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id').all(eventId);
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('المناسبة تتطلب صاحب الدعوة وأسماء أصحاب المناسبة', async () => {
  const base = { venue: 'قاعة', date: '2099-01-01', time: '20:00' };
  assert.equal((await api('POST', '/api/events', { ...base, honorees: 'خالد' })).status, 400);
  assert.equal((await api('POST', '/api/events', { ...base, hostLine: 'أبو خالد' })).status, 400);
});

test('الدعوة تُرسل بنص الرسالة وصورة البطاقة وثلاثة أزرار', async () => {
  const r = await api('POST', `/api/events/${eventId}/invite`, {});
  assert.equal(r.status, 202);
  assert.ok(await waitFor(() => guests.every((g) => guestRow(g.id).invite_state === 'sent')));
  const box = await api('GET', `/api/events/${eventId}/outbox`);
  assert.equal(box.json.simulate, true);
  const m = box.json.messages.find((x) => x.guestName === 'ريم القصيبي');
  assert.equal(m.channel, 'whatsapp');
  assert.match(m.body, /\*المكرمة : ريم القصيبي\*/);
  assert.match(m.body, /بكل الود والمحبة تتشرف\n\*عائلة العتيبي\*/);
  assert.match(m.body, /بدعوتكم لحضور حفل زفاف\n\*سلطان و ريم\*/);
  assert.match(m.body, /🗓️\| يوم \S+ \d\d\.\d\d\.\d{4}\n/);
  assert.match(m.body, /📍\| فندق فيرست جراند/);
  assert.equal(m.buttons.length, 3);
  assert.deepEqual(m.buttons.map((b) => b.label), ['قبول الدعوة', 'الاعتذار عن الدعوة', 'موقع المناسبة']);
  assert.match(m.buttons[0].payload, /^a:/);
  assert.match(m.image, /^https:\/\/test\.example\/card\/.+\.png$/);
});

test('ضغط الأزرار في المحاكاة يحدّث حالة الضيف', async () => {
  const g = guests[0];
  let r = await api('POST', `/api/events/${eventId}/guests/${g.id}/simulate`, { action: 'a' });
  assert.equal(r.json.ok, true);
  assert.equal(guestRow(g.id).status, 'accepted');
  assert.match(r.json.reply, /تم تسجيل قبولكم/);
  assert.ok(r.json.reply.includes(`/i/${g.token}`));

  r = await api('POST', `/api/events/${eventId}/guests/${g.id}/simulate`, { action: 'd' });
  assert.equal(guestRow(g.id).status, 'declined');

  r = await api('POST', `/api/events/${eventId}/guests/${g.id}/simulate`, { action: 'l' });
  assert.match(r.json.reply, /فندق فيرست جراند/);
  assert.match(r.json.reply, /https:\/\/maps\.example\/abc/);
  assert.equal(guestRow(g.id).status, 'declined', 'زر الموقع لا يغيّر الحالة');

  assert.equal((await api('POST', `/api/events/${eventId}/guests/${g.id}/simulate`, { action: 'x' })).status, 400);
});

test('الـ Webhook: التحقق، التوقيع، ضغطة زر حقيقية', async () => {
  let r = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '12345');
  r = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(r.status, 403);

  const g = guests[1];
  assert.equal((await webhook(buttonMsg(g.phone, `a:${g.token}`), { signed: false })).status, 403);
  assert.equal(guestRow(g.id).status, 'pending');

  assert.equal((await webhook(buttonMsg(g.phone, `a:${g.token}`))).status, 200);
  assert.ok(await waitFor(() => guestRow(g.id).status === 'accepted'));

  // رقم مرسل مختلف عن رقم الضيف: يُتجاهل
  await webhook(buttonMsg('966509999999', `d:${g.token}`));
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(guestRow(g.id).status, 'accepted');

  assert.ok(db.prepare("SELECT 1 FROM outbox WHERE guest_id = ? AND kind = 'reply'").get(g.id));
});

test('الـ Webhook: حالات التسليم والفشل', async () => {
  const g = guests[1];
  const row = db.prepare("SELECT * FROM outbox WHERE guest_id = ? AND kind = 'invite'").get(g.id);
  await webhook(statusMsg(row.ext_id, 'delivered'));
  assert.ok(await waitFor(() => guestRow(g.id).invite_delivery === 'delivered'));
  await webhook(statusMsg(row.ext_id, 'read'));
  assert.ok(await waitFor(() => guestRow(g.id).invite_delivery === 'read'));
  await webhook(statusMsg(row.ext_id, 'delivered')); // لا يتراجع من «قُرئت»
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(guestRow(g.id).invite_delivery, 'read');

  await webhook(statusMsg(row.ext_id, 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
  assert.ok(await waitFor(() => guestRow(g.id).invite_state === 'failed'));
  assert.match(guestRow(g.id).invite_error, /undeliverable/);
});

test('بطاقة الدعوة PNG ورمز QR بصيغة SVG', async () => {
  const g = guests[0];
  const png = await fetch(`${base}/card/${g.token}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await png.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.ok(buf.length > 20000);
  const svg = await fetch(`${base}/qr/${g.token}.svg`);
  assert.equal(svg.status, 200);
  assert.match(await svg.text(), /<svg/);
  assert.equal((await fetch(`${base}/card/nonexistent123.png`)).status, 404);
});

test('وضع Cloud: حمولة Meta الصحيحة', async () => {
  const g = guestRow(guests[0].id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const saved = { ...cfg };
  const calls = [];
  const realFetch = global.fetch;
  Object.assign(cfg, { WHATSAPP_MODE: 'cloud', WHATSAPP_TOKEN: 'TOK', WHATSAPP_PHONE_ID: '12345' });
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.XYZ' }] }) };
  };
  try {
    const r = await wa.sendTemplate('invite', g, ev);
    assert.equal(r.ok, true, r.error);
  } finally {
    global.fetch = realFetch;
    Object.assign(cfg, saved);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/12345/messages');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOK');
  const p = JSON.parse(calls[0].opts.body);
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, g.phone);
  assert.equal(p.template.name, 'hayyak_invite');
  assert.equal(p.template.language.code, 'ar');
  const [header, body, ...btns] = p.template.components;
  assert.equal(header.parameters[0].image.link, `https://test.example/card/${g.token}.png`);
  assert.equal(body.parameters.length, 6);
  assert.ok(body.parameters.every((x) => x.type === 'text' && !/\n/.test(x.text)));
  assert.equal(btns.length, 3);
  assert.deepEqual(btns.map((b) => b.index), ['0', '1', '2']);
  assert.equal(btns[1].parameters[0].payload, `d:${g.token}`);
  const logged = db.prepare("SELECT * FROM outbox WHERE ext_id = 'wamid.XYZ'").get();
  assert.ok(logged);
});

test('وضع Cloud: رفض Meta يظهر كفشل بسبب واضح', async () => {
  const g = guestRow(guests[0].id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const saved = { ...cfg };
  const realFetch = global.fetch;
  Object.assign(cfg, { WHATSAPP_MODE: 'cloud', WHATSAPP_TOKEN: 'TOK', WHATSAPP_PHONE_ID: '12345' });
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Template not found', code: 132001 } }) });
  try {
    const r = await wa.sendTemplate('invite', g, ev);
    assert.equal(r.ok, false);
    assert.match(r.error, /Template not found/);
    assert.match(r.error, /132001/);
  } finally {
    global.fetch = realFetch;
    Object.assign(cfg, saved);
  }
});

test('التذكير بقالب مستقل وأزرار تأكيد', async () => {
  const g = guestRow(guests[0].id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const m = wa.build('reminder', g, ev);
  assert.equal(m.template, 'hayyak_reminder');
  assert.match(m.text, /نذكّركم بدعوتكم لحضور حفل زفاف/);
  assert.deepEqual(m.buttons.map((b) => b.label), ['أؤكد حضوري', 'أعتذر عن الحضور', 'موقع المناسبة']);
  assert.ok(!wa.BODY_INVITE.startsWith('{{') && !wa.BODY_INVITE.trimEnd().endsWith('}}'));
  assert.ok(!wa.BODY_REMINDER.startsWith('{{') && !wa.BODY_REMINDER.trimEnd().endsWith('}}'));
});
