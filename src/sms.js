// طبقة الإرسال. المزودون المدعومون:
//   console  — وضع تجريبي: يسجّل الرسالة في سجل الرسائل ولا يرسل شيئاً
//   taqnyat  — تقنيات (السعودية)، تم التحقق من الواجهة من توثيقها الرسمي: https://dev.taqnyat.sa/ar/doc/sms/
// لإضافة مزود جديد: أضف دالة في الكائن providers تستقبل (to, body) وترمي خطأً عند الفشل.
const db = require('./db');
const cfg = require('./env');

const providers = {
  async console(to, body) {
    console.log(`[SMS تجريبي] إلى ${to}\n${body}\n`);
    return {};
  },

  async taqnyat(to, body) {
    if (!cfg.SMS_API_KEY || !cfg.SMS_SENDER) {
      throw new Error('إعدادات تقنيات ناقصة: SMS_API_KEY و SMS_SENDER');
    }
    const res = await fetch('https://api.taqnyat.sa/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.SMS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipients: [Number(to)], body, sender: cfg.SMS_SENDER }),
      signal: AbortSignal.timeout(15000),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ردّ بدون JSON */ }
    if (res.status !== 201) throw new Error(data.message || `رفض المزود الطلب (HTTP ${res.status})`);
    // الحقل rejected نص مثل "[]" وإن وُجدت أرقام داخله فالرقم مرفوض
    if (/\d/.test(String(data.rejected || ''))) throw new Error('رفض المزود رقم الجوال');
    return { messageId: data.messageId };
  },
};

async function send({ guestId = null, eventId = null, kind, to, body }) {
  const name = providers[cfg.SMS_PROVIDER] ? cfg.SMS_PROVIDER : null;
  let ok = false;
  let error = null;
  try {
    if (!name) throw new Error(`مزود الرسائل غير معروف: ${cfg.SMS_PROVIDER}`);
    await providers[name](to, body);
    ok = true;
  } catch (err) {
    error = String(err.message || err).slice(0, 300);
  }
  db.prepare(
    `INSERT INTO outbox (guest_id, event_id, kind, to_phone, body, provider, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(guestId, eventId, kind, to, body, name || cfg.SMS_PROVIDER, ok ? 1 : 0, error);
  return { ok, error };
}

module.exports = { send };
