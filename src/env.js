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

module.exports = {
  PORT,
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''),
  SMS_PROVIDER: (process.env.SMS_PROVIDER || 'console').toLowerCase(),
  SMS_SENDER: process.env.SMS_SENDER || '',
  SMS_API_KEY: process.env.SMS_API_KEY || '',
  SMS_APP_SID: process.env.SMS_APP_SID || '',
  // قناة الدعوات: whatsapp (افتراضي) أو sms
  INVITE_CHANNEL: (process.env.INVITE_CHANNEL || 'whatsapp').toLowerCase() === 'sms' ? 'sms' : 'whatsapp',
  // console = معاينة تجريبية بدون إرسال فعلي، cloud = واتساب للأعمال (Meta Cloud API)
  WHATSAPP_MODE: (process.env.WHATSAPP_MODE || 'console').toLowerCase() === 'cloud' ? 'cloud' : 'console',
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || '',
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || '',
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || '',
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || 'v23.0',
  WHATSAPP_TEMPLATE_INVITE: process.env.WHATSAPP_TEMPLATE_INVITE || 'hayyak_invite',
  WHATSAPP_TEMPLATE_REMINDER: process.env.WHATSAPP_TEMPLATE_REMINDER || 'hayyak_reminder',
  WHATSAPP_LANG: process.env.WHATSAPP_LANG || 'ar',
  // ساعة إرسال التذكير (بتوقيت الرياض) في اليوم السابق للمناسبة
  REMINDER_HOUR: Number(process.env.REMINDER_HOUR || 10),
  SCHEDULER_INTERVAL_MS: Number(process.env.SCHEDULER_INTERVAL_MS || 60000),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};
