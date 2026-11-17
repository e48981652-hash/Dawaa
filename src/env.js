// تحميل ملف .env بدون أي اعتماديات خارجية
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const PORT = Number(process.env.PORT || 3000);

// قناة واتساب: console = معاينة تجريبية بدون إرسال، waha = WAHA (محرك WEBJS)
const rawMode = (process.env.WHATSAPP_MODE || 'console').toLowerCase();
if (rawMode === 'cloud') {
  console.warn('[إعداد] WHATSAPP_MODE=cloud لم يعد مدعومًا (أُزيل تكامل Meta Cloud) — يعمل التطبيق في وضع console');
}
const WHATSAPP_MODE = rawMode === 'waha' ? 'waha' : 'console';

const stripSlash = (v) => String(v || '').replace(/\/+$/, '');

module.exports = {
  PORT,
  PUBLIC_BASE_URL: stripSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`),
  SMS_PROVIDER: (process.env.SMS_PROVIDER || 'console').toLowerCase(),
  SMS_SENDER: process.env.SMS_SENDER || '',
  SMS_API_KEY: process.env.SMS_API_KEY || '',
  SMS_APP_SID: process.env.SMS_APP_SID || '',
  // قناة الدعوات: whatsapp (افتراضي) أو sms
  INVITE_CHANNEL: (process.env.INVITE_CHANNEL || 'whatsapp').toLowerCase() === 'sms' ? 'sms' : 'whatsapp',
  WHATSAPP_MODE,

  // ── WAHA (WhatsApp HTTP API — محرك WEBJS) ──
  WAHA_BASE_URL: stripSlash(process.env.WAHA_BASE_URL || 'http://127.0.0.1:3006'),
  WAHA_API_KEY: process.env.WAHA_API_KEY || '',
  WAHA_SESSION: process.env.WAHA_SESSION || 'default',
  WAHA_WEBHOOK_HMAC_KEY: process.env.WAHA_WEBHOOK_HMAC_KEY || '',
  // تباعد بين الرسائل لتقليل خطر حظر الرقم (مللي ثانية)
  WAHA_SEND_DELAY_MS: Number(process.env.WAHA_SEND_DELAY_MS || 4000),
  WAHA_SEND_JITTER_MS: Number(process.env.WAHA_SEND_JITTER_MS || 3000),

  // ساعة إرسال التذكير (بتوقيت الرياض) في اليوم السابق للمناسبة
  REMINDER_HOUR: Number(process.env.REMINDER_HOUR || 10),
  SCHEDULER_INTERVAL_MS: Number(process.env.SCHEDULER_INTERVAL_MS || 60000),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};
