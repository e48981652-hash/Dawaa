// تطبيع أرقام الجوال لأي دولة في العالم (الدولة الافتراضية السعودية، وتتغير من الواجهة أو DEFAULT_COUNTRY_CODE)

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

function toLatinDigits(str) {
  return String(str).replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EASTERN_PERSIAN.indexOf(ch));
  });
}

const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '966').replace(/\D/g, '');

/** رمز الدولة القادم من الواجهة: undefined = الافتراضي، '' = بدون (الرقم لازم يبدأ بـ +)، وإلا أرقام فقط */
function parseCountry(v) {
  if (v === undefined || v === null) return DEFAULT_CC;
  const d = toLatinDigits(v).replace(/\D/g, '');
  return d.length <= 4 ? d : DEFAULT_CC;
}

const VALID = /^[1-9]\d{7,14}$/; // معيار E.164: حتى 15 رقماً

/**
 * يرجع الرقم بصيغة دولية بدون + (مثال: 966501234567) أو null إذا كان غير صالح. يقبل رقم أي دولة.
 * - مع + أو 00: يُؤخذ كما هو (+201012345678 / 00966501234567).
 * - بدون ذلك: يُضاف رمز الدولة المختارة cc (الافتراضي 966). الصفر الأول يُحذف: 0501234567 / 01012345678 / 011 069 1234.
 * - الأرقام العربية (٠١٢) مقبولة.
 */
function normalizePhone(raw, cc = DEFAULT_CC) {
  if (raw === null || raw === undefined) return null;
  const s = toLatinDigits(raw).trim();
  const explicitIntl = /^(\+|00)/.test(s);
  let d = s.replace(/[^\d]/g, '');
  let full;
  if (explicitIntl) {
    if (d.startsWith('00')) d = d.slice(2);
    full = d;
    // +966 0501234567 أو +20 01012345678: الصفر بعد رمز الدولة زائد
    for (const c of new Set([cc, '966', '20'].filter(Boolean))) {
      if (full.startsWith(c + '0') && full.length > c.length + 7) { full = c + full.slice(c.length + 1); break; }
    }
  } else {
    if (!cc) return null; // لا دولة محددة: لازم يكتب + ورمز الدولة
    if (d.startsWith('0')) full = cc + d.slice(1);
    else if (d.startsWith(cc) && d.length - cc.length >= 7) full = d; // الرقم فيه رمز الدولة أصلاً
    else full = cc + d;
  }
  if (!explicitIntl && full.length - (cc || '').length < 6) return null; // رقم محلي أقصر من اللازم
  return VALID.test(full) ? full : null;
}

/** عرض الرقم للمنظّم: 05x xxx xxxx للجوال السعودي، وغيره +الرقم */
function displayPhone(p) {
  if (/^9665\d{8}$/.test(p)) {
    const n = p.slice(3);
    return `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
  }
  return '+' + p;
}

/**
 * يحلل نصاً ملصوقاً (سطر لكل ضيف). يقبل "الاسم، الرقم" أو "الرقم الاسم" أو الرقم وحده.
 * يرجع { rows:[{name,phone}], errors:[{line,reason}] }
 */
function parseBulk(text, cc = DEFAULT_CC) {
  const rows = [];
  const errors = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const latin = toLatinDigits(line);
    const m = latin.match(/(\+|00)?[\d][\d\s\-()]{5,}\d/);
    if (!m) {
      errors.push({ line, reason: 'ما لقينا رقم جوال في هذا السطر' });
      continue;
    }
    const phone = normalizePhone(m[0], cc);
    if (!phone) {
      errors.push({ line, reason: 'رقم الجوال غير صحيح' });
      continue;
    }
    const name = cleanName(line, m[0]);
    rows.push({ name: name || 'ضيف', phone });
  }
  return { rows, errors };
}

function cleanName(originalLine, matchedLatin) {
  // نحذف مقطع الرقم من السطر الأصلي بحسب موقعه (التحويل يحافظ على الأطوال)
  const latin = toLatinDigits(originalLine);
  const idx = latin.indexOf(matchedLatin);
  const without = idx >= 0
    ? originalLine.slice(0, idx) + ' ' + originalLine.slice(idx + matchedLatin.length)
    : originalLine;
  return without.replace(/[,،;؛\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

module.exports = { normalizePhone, displayPhone, parseBulk, parseCountry, toLatinDigits, DEFAULT_CC };
