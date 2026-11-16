// صورة بطاقة الدعوة (PNG 1080×1350): تُرسل كترويسة لرسالة واتساب، ويظهر فيها رمز QR خاص بكل ضيف.
// نبني SVG بألوان وخطوط وزخارف القالب ثم نحوّله إلى PNG بمكتبة resvg (خطوط مضمّنة في assets/fonts).
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Resvg } = require('@resvg/resvg-js');
const { THEMES, SHAPES } = require('./theme-data');
const { describe } = require('./format');
const { DEFAULT_TEMPLATE } = require('./templates');

const W = 1080;
const H = 1350;
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const BODY_FONT = 'IBM Plex Sans Arabic';

const fontFiles = fs.existsSync(FONT_DIR)
  ? fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONT_DIR, f))
  : [];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** تقسيم نص إلى أسطر بحسب عرض تقريبي (الخط العربي ≈ 0.5 من حجمه لكل حرف) */
function wrap(text, size, maxWidth) {
  const perLine = Math.max(6, Math.floor(maxWidth / (size * 0.5)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > perLine) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** مصفوفة QR كمسار SVG واحد */
function qrPath(text, cell) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const d = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!qr.modules.data[y * n + x]) { x++; continue; }
      let run = 1;
      while (x + run < n && qr.modules.data[y * n + x + run]) run++;
      d.push(`M${x * cell} ${y * cell}h${run * cell}v${cell}h${-run * cell}z`);
      x += run;
    }
  }
  return { d: d.join(''), size: n * cell, modules: n };
}

/** شريط زخرفة متكرر داخل مستطيل */
function tile(id, shapeSpec, x, y, w, h, scale) {
  const s = SHAPES[shapeSpec.shape];
  const tw = shapeSpec.w * scale;
  const th = shapeSpec.h * scale;
  // نبدأ من منتصف العرض ليبقى النقش متناسقاً على الجانبين
  return `<pattern id="${id}" x="${x + (w % tw) / 2}" y="${y + (h - th) / 2}" width="${tw}" height="${th}" patternUnits="userSpaceOnUse">
    <svg width="${tw}" height="${th}" viewBox="0 0 ${s.vw} ${s.vh}">${s.inner(shapeSpec.color)}</svg>
  </pattern>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id})"/>`;
}

/**
 * @param {object} o
 *   template, occasion, host, honorees, startsAt (ISO), venue, qrUrl
 */
function cardSvg(o) {
  const t = THEMES[o.template] || THEMES[DEFAULT_TEMPLATE];
  const family = t.family;
  const d = o.startsAt ? describe(o.startsAt) : null;

  const m = 44; // هامش البطاقة عن حافة الصورة
  const cw = W - m * 2;
  const ch = H - m * 2;
  const rx = Math.min(t.radius * 2, 60);
  const cx = W / 2;

  const bandH = 150;
  const band = t.bandOrn || t.orn;
  const parts = [];

  // --- النصوص ---
  let y = m + bandH + 96;
  const text = (str, size, fill, { font = BODY_FONT, weight = 400, dy = 0, spacing = 0 } = {}) => {
    const out = `<text x="${cx}" y="${y + dy}" text-anchor="middle" direction="rtl" font-family="${esc(font)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(str)}</text>`;
    parts.push(out);
  };

  text('بكل الود والمحبة تتشرف', 34, t.muted, { weight: 500 });
  y += 78;

  if (o.host) {
    const hl = wrap(o.host, 42, cw - 140).slice(0, 2);
    for (const ln of hl) {
      text(ln, 42, t.ink, { weight: 700 });
      y += 58;
    }
  }
  text(`بدعوتكم لحضور ${o.occasion || 'المناسبة'}`, 36, t.ink, { weight: 400 });
  y += 24;

  // أسماء أصحاب المناسبة بخط القالب، تصغير تلقائي للأسماء الطويلة
  const honorees = String(o.honorees || '').trim();
  let hs = Math.min(t.size * 2.1, 92);
  let lines = wrap(honorees, hs, cw - 140);
  while (lines.length > 2 && hs > 56) {
    hs -= 6;
    lines = wrap(honorees, hs, cw - 140);
  }
  if (lines.length === 1) while (honorees.length * hs * 0.5 > cw - 140 && hs > 56) hs -= 4;
  y += hs * 1.0;
  for (const ln of lines) {
    text(ln, Math.round(hs), t.title, { font: family, weight: t.weight });
    y += hs * 1.2;
  }
  y -= hs * 0.35;

  // فاصل زخرفي
  y += 26;
  const sepY = y;
  parts.push(tile('sep', t.orn, m + 140, sepY - (t.orn.h * 2) / 2, cw - 280, t.orn.h * 2, 2));
  y += t.orn.h * 2 + 70;

  if (d) {
    text(`${d.weekday} ${d.gregorian}`, 44, t.ink, { weight: 700 });
    y += 52;
    text(`الموافق ${d.hijri}`, 30, t.muted, { weight: 400 });
    y += 58;
    text(`الساعة ${d.time}`, 38, t.ink, { weight: 600 });
    y += 30;
  }
  if (o.venue) {
    y += 40;
    const vl = wrap(o.venue, 36, cw - 160).slice(0, 2);
    for (const ln of vl) {
      text(ln, 36, t.ink, { weight: 500 });
      y += 50;
    }
    y -= 10;
  }

  // --- QR ---
  const bottom = m + ch - 90; // مساحة لسطر «امسح الرمز» أسفل المربع
  const qrBox = Math.max(190, Math.min(250, bottom - (y + 30)));
  const qrY = Math.max(y + 30, bottom - qrBox);
  let qrSvg = '';
  if (o.qrUrl) {
    const probe = qrPath(o.qrUrl, 1);
    const cell = Math.floor((qrBox - 40) / probe.modules);
    const q = qrPath(o.qrUrl, cell);
    const bx = cx - qrBox / 2;
    const ox = bx + (qrBox - q.size) / 2;
    const oy = qrY + (qrBox - q.size) / 2;
    qrSvg = `<rect x="${bx}" y="${qrY}" width="${qrBox}" height="${qrBox}" rx="18" fill="#FFFFFF" stroke="${t.accent}" stroke-width="4"/>
      <path transform="translate(${ox} ${oy})" d="${q.d}" fill="#111111"/>
      <text x="${cx}" y="${qrY + qrBox + 46}" text-anchor="middle" direction="rtl" font-family="${BODY_FONT}" font-size="28" font-weight="500" fill="${t.muted}">امسح الرمز لتأكيد حضورك</text>`;
  }

  const frame = /solid/.test(t.frame)
    ? `<rect x="${m + 14}" y="${m + 14}" width="${cw - 28}" height="${ch - 28}" rx="${Math.max(rx - 8, 0)}" fill="none" stroke="rgba(212,175,55,.55)" stroke-width="2"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="clip"><rect x="${m}" y="${m}" width="${cw}" height="${ch}" rx="${rx}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="${t.page}"/>
  <rect x="${m}" y="${m}" width="${cw}" height="${ch}" rx="${rx}" fill="${t.card}"/>
  <g clip-path="url(#clip)">
    <rect x="${m}" y="${m}" width="${cw}" height="${bandH}" fill="${t.bandBg}"/>
    ${tile('band', band, m, m + (bandH - band.h * 3) / 2, cw, band.h * 3, 3)}
  </g>
  ${frame}
  ${parts.join('\n  ')}
  ${qrSvg}
</svg>`;
}

const cache = new Map();
const MAX_CACHE = 200;

/** يرجع Buffer لصورة PNG. النتيجة تُخزَّن مؤقتاً بحسب المدخلات. */
function renderCard(o) {
  const svg = cardSvg(o);
  const hit = cache.get(svg);
  if (hit) return hit;
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: BODY_FONT },
  }).render().asPng();
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(svg, png);
  return png;
}

module.exports = { cardSvg, renderCard, W, H };
