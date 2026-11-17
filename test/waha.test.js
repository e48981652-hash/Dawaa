// WAHA (WEBJS): الإرسال (صورة + استفتاء)، الـ Webhook الموقَّع، الردود، وحالات التسليم.
// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HMAC_KEY = 'hook-secret';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hayyak-waha-'));

let stub;
let stubCalls = [];
let failPoll = false;
let server;
let base;
let token;
let eventId;
let guests;
let cfg;
let db;
let wa;

const sign = (raw) => crypto.createHmac('sha512', HMAC_KEY).update(raw).digest('hex');

function startStub() {
  return new Promise((resolve) => {
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* ليس JSON */ }
        stubCalls.push({ path: req.url, method: req.method, headers: req.headers, body: json });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET' && req.url.startsWith('/api/sessions/')) {
          return res.end(JSON.stringify({ name: 'default', status: 'WORKING' }));
        }
        if (req.url === '/api/sendPoll' && failPoll) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ message: 'poll failed' }));
        }
        const id = req.url === '/api/sendImage'
          ? `img_${stubCalls.length}`
          : req.url === '/api/sendPoll' ? `poll_${stubCalls.length}` : `txt_${stubCalls.length}`;
        res.end(JSON.stringify({ id }));
      });
    });
    stub.listen(0, '127.0.0.1', () => resolve(stub));
  });
}

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

async function webhook(payload, { signed = true } = {}) {
  const raw = JSON.stringify(payload);
  return fetch(base + '/webhooks/waha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signed ? { 'X-Webhook-Hmac': sign(raw) } : {}) },
    body: raw,
  });
}

const pollVote = (evtId, pollId, phone, option) => ({
  id: evtId,
  event: 'poll.vote',
  session: 'default',
  engine: 'WEBJS',
  payload: {
    vote: { id: `vote_${evtId}`, from: `${phone}@c.us`, selectedOptions: [option], timestamp: Date.now(), to: `${phone}@c.us`, fromMe: false },
    poll: { id: pollId, to: `${phone}@c.us`, from: '966500000000@c.us', fromMe: true },
  },
});

const textMsg = (evtId, phone, text) => ({
  id: evtId,
  event: 'message',
  session: 'default',
  engine: 'WEBJS',
  payload: { id: `msg_${evtId}`, from: `${phone}@c.us`, to: '966500000000@c.us', fromMe: false, body: text },
});

const ackMsg = (evtId, msgId, ackName) => ({
  id: evtId,
  event: 'message.ack',
  session: 'default',
  engine: 'WEBJS',
  payload: { id: msgId, from: '966500000000@c.us', to: '966500000000@c.us', participant: null, fromMe: true, ack: 3, ackName },
});

const guestRow = (id) => db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
const outboxRow = (id, kind) => db.prepare('SELECT * FROM outbox WHERE guest_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(id, kind);
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test.before(async () => {
  await startStub();
  const stubPort = stub.address().port;
  Object.assign(process.env, {
    DATA_DIR,
    INVITE_CHANNEL: 'whatsapp',
    WHATSAPP_MODE: 'waha',
    WAHA_BASE_URL: `http://127.0.0.1:${stubPort}`,
    WAHA_API_KEY: 'test-key',
    WAHA_SESSION: 'default',
    WAHA_WEBHOOK_HMAC_KEY: HMAC_KEY,
    WAHA_SEND_DELAY_MS: '0',
    WAHA_SEND_JITTER_MS: '0',
    SCHEDULER_INTERVAL_MS: '3600000',
    PORT: '0',
    PUBLIC_BASE_URL: 'https://test.example',
  });
  cfg = require('../src/env');
  db = require('../src/db');
  wa = require('../src/whatsapp');
  const { start } = require('../server');
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
  const add = await api('POST', `/api/events/${eventId}/guests`, { text: 'ريم القصيبي 0502222222\nفهد 0503333333', honorific: 'f' });
  assert.equal(add.json.added, 2);
  guests = db.prepare('SELECT * FROM guests WHERE event_id = ? ORDER BY id').all(eventId);
});

test.after(() => {
  server.close();
  stub.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ملف القاعدة مفتوح على ويندوز */ }
});

test('الدعوة تُرسل كصورة + استفتاء بخيارين وتُسجَّل في outbox', async () => {
  const before = stubCalls.length;
  const r = await api('POST', `/api/events/${eventId}/invite`, {});
  assert.equal(r.status, 202);
  assert.ok(await waitFor(() => guests.every((g) => guestRow(g.id).invite_state === 'sent')));

  const sent = stubCalls.slice(before);
  assert.equal(sent.filter((c) => c.path === '/api/sendImage').length, 2);
  assert.equal(sent.filter((c) => c.path === '/api/sendPoll').length, 2);
  assert.ok(sent.every((c) => c.headers['x-api-key'] === 'test-key'));
  assert.ok(sent.every((c) => c.body.session === 'default'));

  const img = sent.find((c) => c.path === '/api/sendImage');
  assert.equal(img.body.chatId, `${guests[0].phone}@c.us`);
  assert.equal(img.body.file.mimetype, 'image/png');
  assert.ok(Buffer.from(img.body.file.data, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.match(img.body.caption, /🔗 للرد على الدعوة: https:\/\/test\.example\/i\//);
  assert.match(img.body.caption, /🗺️ موقع المناسبة: https:\/\/maps\.example\/abc/);

  const poll = sent.find((c) => c.path === '/api/sendPoll');
  assert.deepEqual(poll.body.poll.options, ['قبول الدعوة', 'الاعتذار عن الدعوة']);
  assert.equal(poll.body.poll.multipleAnswers, false);

  const row = outboxRow(guests[0].id, 'invite');
  assert.ok(row.ext_id);
  assert.ok(row.poll_ext_id);
  assert.equal(row.source, 'waha');
  const meta = JSON.parse(row.meta);
  assert.equal(meta.interactive, 'poll');
  assert.equal(meta.fallback, false);
  assert.deepEqual(meta.options.map((o) => o.label), ['قبول الدعوة', 'الاعتذار عن الدعوة']);
});

test('Webhook بتوقيع خاطئ يُرفض ولا يغيّر الحالة', async () => {
  const g = guests[0];
  const pollId = outboxRow(g.id, 'invite').poll_ext_id;
  const r = await webhook(pollVote('evt_bad_sig', pollId, g.phone, 'قبول الدعوة'), { signed: false });
  assert.equal(r.status, 403);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(guestRow(g.id).status, 'pending');
});

test('poll.vote «قبول الدعوة» يحدّث الضيف ويظهر كرد وارد', async () => {
  const g = guests[0];
  const pollId = outboxRow(g.id, 'invite').poll_ext_id;
  assert.equal((await webhook(pollVote('evt_poll_accept', pollId, g.phone, 'قبول الدعوة'))).status, 200);
  assert.ok(await waitFor(() => guestRow(g.id).status === 'accepted'));
  assert.ok(guestRow(g.id).responded_at);
  assert.ok(guestRow(g.id).last_inbound_at);

  const inbound = outboxRow(g.id, 'inbound');
  assert.equal(inbound.body, 'قبول الدعوة');
  assert.equal(inbound.source, 'waha');
  assert.ok(await waitFor(() => !!outboxRow(g.id, 'reply')), 'يُرسل رد شكر للضيف');
});

test('نفس حدث poll.vote مرة ثانية لا يُعالَج مرتين', async () => {
  const g = guests[0];
  const pollId = outboxRow(g.id, 'invite').poll_ext_id;
  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE guest_id = ? AND kind = 'inbound'").get(g.id).c;
  await webhook(pollVote('evt_poll_accept', pollId, g.phone, 'الاعتذار عن الدعوة'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(guestRow(g.id).status, 'accepted');
  const countAfter = db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE guest_id = ? AND kind = 'inbound'").get(g.id).c;
  assert.equal(countAfter, countBefore);
});

test('رسالة نصية «أعتذر» تُسجّل الاعتذار', async () => {
  const g = guests[1];
  assert.equal((await webhook(textMsg('evt_text_decline', g.phone, 'أعتذر'))).status, 200);
  assert.ok(await waitFor(() => guestRow(g.id).status === 'declined'));
  assert.equal(outboxRow(g.id, 'inbound').body, 'أعتذر');
});

test('message.ack READ يحدّث حالة التسليم', async () => {
  const g = guests[0];
  const row = outboxRow(g.id, 'invite');
  assert.equal((await webhook(ackMsg('evt_ack_read', row.ext_id, 'READ'))).status, 200);
  assert.ok(await waitFor(() => guestRow(g.id).invite_delivery === 'read'));
  assert.equal(outboxRow(g.id, 'invite').delivery, 'read');
  // لا تتراجع من «قُرئت» إلى «وصلت»
  await webhook(ackMsg('evt_ack_device', row.ext_id, 'DEVICE'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(guestRow(g.id).invite_delivery, 'read');
});

test('سجل الرسائل يعرض الردود الواردة', async () => {
  const r = await api('GET', `/api/events/${eventId}/outbox`);
  assert.equal(r.json.provider, 'whatsapp-waha');
  assert.equal(r.json.simulate, false);
  const inbound = r.json.messages.filter((m) => m.kind === 'inbound');
  assert.ok(inbound.length >= 2);
  assert.ok(inbound.some((m) => m.body === 'قبول الدعوة'));
  assert.ok(inbound.some((m) => m.body === 'أعتذر'));
});

test('session.status يظهر في /api/waha/status', async () => {
  await webhook({
    id: 'evt_status_1',
    event: 'session.status',
    session: 'default',
    engine: 'WEBJS',
    payload: { name: 'default', status: 'WORKING', statuses: [] },
    me: { id: '966500000000@c.us', pushName: 'حيّاك' },
  });
  assert.ok(await waitFor(() => db.prepare('SELECT status FROM wa_status WHERE id = 1').get()?.status === 'WORKING'));
  const r = await api('GET', '/api/waha/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'WORKING');
  assert.equal(r.json.phone, '966500000000');
});

test('فشل الاستفتاء يتحول تلقائياً إلى رسالة نصية فيها الرابط', async () => {
  failPoll = true;
  try {
    const g = guests[1];
    const before = stubCalls.length;
    await api('POST', `/api/events/${eventId}/invite`, { guestIds: [g.id], resend: true });
    assert.ok(await waitFor(() => guestRow(g.id).invite_state === 'sent'));
    const sent = stubCalls.slice(before);
    assert.ok(sent.some((c) => c.path === '/api/sendText'));
    const row = outboxRow(g.id, 'invite');
    const meta = JSON.parse(row.meta);
    assert.equal(meta.interactive, 'text');
    assert.equal(meta.fallback, true);
    assert.match(row.body, /https:\/\/test\.example\/i\//);
  } finally {
    failPoll = false;
  }
});

test('التذكير بخيارَي التأكيد والاعتذار', () => {
  const g = guestRow(guests[0].id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  const m = wa.build('reminder', g, ev);
  assert.match(m.text, /نذكّركم بدعوتكم لحضور حفل زفاف/);
  assert.deepEqual(m.buttons.map((b) => b.label), ['أؤكد حضوري', 'أعتذر عن الحضور']);
});

test('إعدادات WAHA الناقصة تظهر كتنبيه', () => {
  const saved = { ...cfg };
  Object.assign(cfg, { WHATSAPP_MODE: 'waha', PUBLIC_BASE_URL: 'http://localhost:3005', WAHA_WEBHOOK_HMAC_KEY: '' });
  try {
    const problems = wa.configProblems();
    assert.ok(problems.some((p) => p.includes('PUBLIC_BASE_URL')));
    assert.ok(problems.some((p) => p.includes('WAHA_WEBHOOK_HMAC_KEY')));
  } finally {
    Object.assign(cfg, saved);
  }
});

test('معرّف رسالة WEBJS الكائني يُحوَّل إلى نص (وإلا فشل حفظ outbox)', () => {
  const waha = require('../src/waha');
  assert.equal(waha.idOf({ id: { fromMe: true, remote: '2010@c.us', id: 'ABC', _serialized: 'true_2010@c.us_ABC' } }), 'true_2010@c.us_ABC');
  assert.equal(waha.idOf({ id: { id: 'ABC' } }), 'ABC');
  assert.equal(waha.idOf({ id: 'plain_id' }), 'plain_id');
  assert.equal(waha.idOf({ _data: { id: 'data_id' } }), 'data_id');
  assert.equal(waha.idOf(null), null);
});

test('وضع console يبقى للمعاينة بدون أي إرسال', async () => {
  const saved = { ...cfg };
  Object.assign(cfg, { WHATSAPP_MODE: 'console' });
  try {
    const g = guestRow(guests[0].id);
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    const before = stubCalls.length;
    const r = await wa.sendTemplate('invite', g, ev);
    assert.equal(r.ok, true);
    assert.equal(stubCalls.length, before, 'لا طلبات إلى WAHA في وضع المعاينة');
    const row = outboxRow(g.id, 'invite');
    assert.equal(row.source, 'console');
    assert.equal(row.delivery, 'sent');
    assert.equal(JSON.parse(row.meta).buttons.length, 2);
  } finally {
    Object.assign(cfg, saved);
  }
});
