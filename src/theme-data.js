// بيانات القوالب: الألوان والخطوط والزخارف. تُستخدم في موقع الدعوة (themes.css المولَّد) وفي صورة بطاقة الدعوة (src/card.js).
// لإضافة قالب: أضف تعريفه هنا، ثم المعرّف والاسم في src/templates.js، ثم شغّل: node tools/build-themes.js

// أشكال الزخارف: viewBox ورسم داخلي. تتكرر أفقياً.
const SHAPES = {
  tri: { vw: 24, vh: 12, inner: (c) => `<path d='M0 0h12L6 12z' fill='${c}'/><path d='M12 12h12L18 0z' fill='${c}' fill-opacity='.4'/>` },
  dots: { vw: 18, vh: 12, inner: (c) => `<circle cx='9' cy='6' r='3.2' fill='${c}'/><circle cx='0' cy='6' r='1.6' fill='${c}' fill-opacity='.45'/><circle cx='18' cy='6' r='1.6' fill='${c}' fill-opacity='.45'/>` },
  star: { vw: 24, vh: 24, inner: (c) => `<g fill='${c}'><rect x='6' y='6' width='12' height='12'/><rect x='6' y='6' width='12' height='12' transform='rotate(45 12 12)'/></g>` },
  diamond: { vw: 20, vh: 12, inner: (c) => `<path d='M10 0l7 6-7 6-7-6z' fill='${c}'/>` },
  gem: { vw: 28, vh: 8, inner: (c) => `<path d='M14 0.5l3.5 3.5-3.5 3.5L10.5 4z' fill='${c}'/>` },
  zigzag: { vw: 16, vh: 12, inner: (c) => `<path d='M0 11L8 1l8 10' fill='none' stroke='${c}' stroke-width='2.5' stroke-linejoin='round'/>` },
  wave: { vw: 24, vh: 12, inner: (c) => `<path d='M0 6q6-7 12 0t12 0' fill='none' stroke='${c}' stroke-width='2.5'/>` },
  beads: { vw: 30, vh: 12, inner: (c) => `<circle cx='5' cy='6' r='2' fill='${c}' fill-opacity='.5'/><circle cx='15' cy='6' r='3.5' fill='${c}'/><circle cx='25' cy='6' r='2' fill='${c}' fill-opacity='.5'/>` },
  bubbles: { vw: 36, vh: 14, inner: () => "<circle cx='6' cy='7' r='4' fill='#F48FB1'/><circle cx='18' cy='7' r='3' fill='#FFC857'/><circle cx='30' cy='7' r='4' fill='#4AA3D0'/>" },
  stripes: { vw: 12, vh: 12, inner: (c) => `<g stroke='${c}' stroke-width='4'><path d='M0 12L12 0'/><path d='M-3 3L3 -3'/><path d='M9 15L15 9'/></g>` },
};

const uri = (shape, color, w, h) => {
  const s = SHAPES[shape];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${s.vw} ${s.vh}'>${s.inner(color)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

// زخرفة بمقاسها بالبكسل (w × h) في صفحة الدعوة؛ وتُكبَّر في صورة البطاقة.
const orn = (shape, color, w, h) => ({ shape, color, w, h, uri: uri(shape, color, w, h) });
const ORN = Object.fromEntries(Object.keys(SHAPES).map((k) => [k, (c, w, h) => orn(k, c, w, h)]));

const SANS = "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif";
const font = (name) => `'${name}', ${SANS}`;

// ── تعريفات القوالب ──
// page: خلفية الصفحة · card: خلفية البطاقة · ink/muted: النص · accent: زر الرد الرئيسي
// btn: الأزرار الصلبة الأخرى · ghost: الأزرار المحدّدة · note: خلفية الملاحظات · link: الروابط
// family: اسم خط العنوان (يوجد ملفه في assets/fonts)
const THEMES = {
  najd: {
    page: '#171B3A', card: '#FFFFFF', ink: '#1D2142', muted: '#5F6384',
    accent: '#E5A832', accentInk: '#171B3A', btn: '#171B3A', btnInk: '#FFFFFF', ghost: '#171B3A',
    title: '#171B3A', font: font('Reem Kufi'), family: 'Reem Kufi', size: 36, weight: 700,
    note: '#F3F2F8', link: '#3B41B5', error: '#A83B3B', radius: 8, frame: 'none',
    orn: ORN.tri('#E5A832', 24, 12), ornH: 12, ornW: 24, bandBg: '#171B3A',
  },
  rose: {
    page: '#7A2E4D', card: '#FFF8F9', ink: '#4A1F33', muted: '#7E5266',
    accent: '#B0446A', accentInk: '#FFFFFF', btn: '#7A2E4D', btnInk: '#FFFFFF', ghost: '#7A2E4D',
    title: '#8F2F57', font: font('Aref Ruqaa'), family: 'Aref Ruqaa', size: 40, weight: 700,
    note: '#FBE8EE', link: '#A03563', error: '#A83B3B', radius: 22, frame: 'none',
    orn: ORN.dots('#B0446A', 18, 12), ornH: 12, ornW: 18, bandBg: '#FBE3EA',
  },
  emerald: {
    page: '#0F3D33', card: '#FBF8EE', ink: '#14352D', muted: '#56695F',
    accent: '#B8903A', accentInk: '#10281F', btn: '#0F3D33', btnInk: '#FFFFFF', ghost: '#0F3D33',
    title: '#0F3D33', font: font('Amiri'), family: 'Amiri', size: 40, weight: 700,
    note: '#EEF2E6', link: '#14685A', error: '#A83B3B', radius: 4, frame: 'none',
    orn: ORN.star('#B8903A', 20, 20), ornH: 20, ornW: 20, bandBg: '#0F3D33',
    bandOrn: ORN.star('#B8903A', 16, 16), bandH: 16, bandW: 16,
  },
  royal: {
    page: '#0B0B0D', card: '#15151A', ink: '#F2E9D0', muted: '#B5AA8C',
    accent: '#D4AF37', accentInk: '#15151A', btn: '#D4AF37', btnInk: '#15151A', ghost: '#E6C75A',
    title: '#D4AF37', font: font('El Messiri'), family: 'El Messiri', size: 38, weight: 700,
    note: '#202027', link: '#E6C75A', error: '#FF9D9D', radius: 2,
    frame: '1px solid rgba(212, 175, 55, 0.55)',
    orn: ORN.diamond('#D4AF37', 20, 12), ornH: 12, ornW: 20, bandBg: '#15151A',
  },
  pearl: {
    page: '#E9E7E2', card: '#FFFFFF', ink: '#2B2B2B', muted: '#6F6B64',
    accent: '#2B2B2B', accentInk: '#FFFFFF', btn: '#2B2B2B', btnInk: '#FFFFFF', ghost: '#2B2B2B',
    title: '#2B2B2B', font: font('Tajawal'), family: 'Tajawal', size: 42, weight: 300,
    note: '#F5F4F1', link: '#2B2B2B', error: '#A83B3B', radius: 2, frame: 'none',
    orn: ORN.gem('#A8A294', 28, 8), ornH: 8, ornW: 28, bandBg: '#F5F4F1',
  },
  sand: {
    page: '#3D4A2E', card: '#F6EEDA', ink: '#3B2A1E', muted: '#756150',
    accent: '#9A5B13', accentInk: '#FFFFFF', btn: '#4A3A1E', btnInk: '#FFFFFF', ghost: '#5A3A14',
    title: '#5A3A14', font: font('Markazi Text'), family: 'Markazi Text', size: 46, weight: 700,
    note: '#EBDFC3', link: '#7A4A0E', error: '#A83B3B', radius: 0, frame: 'none',
    orn: ORN.zigzag('#9A5B13', 16, 12), ornH: 12, ornW: 16, bandBg: '#EBDFC3',
  },
  sea: {
    page: '#06505F', card: '#F2FBFB', ink: '#0B3A45', muted: '#4B717C',
    accent: '#0B7A7C', accentInk: '#FFFFFF', btn: '#06505F', btnInk: '#FFFFFF', ghost: '#06505F',
    title: '#06505F', font: font('Cairo'), family: 'Cairo', size: 34, weight: 700,
    note: '#DFF1F2', link: '#0B6F77', error: '#A83B3B', radius: 14, frame: 'none',
    orn: ORN.wave('#0B7A7C', 24, 12), ornH: 12, ornW: 24, bandBg: '#DFF1F2',
  },
  lavender: {
    page: '#4A3A73', card: '#FAF7FF', ink: '#2F2550', muted: '#665C8A',
    accent: '#7557B8', accentInk: '#FFFFFF', btn: '#4A3A73', btnInk: '#FFFFFF', ghost: '#4A3A73',
    title: '#4A3A73', font: font('Lateef'), family: 'Lateef', size: 48, weight: 700,
    note: '#EFE9FB', link: '#5A3FA5', error: '#A83B3B', radius: 26, frame: 'none',
    orn: ORN.beads('#7557B8', 30, 12), ornH: 12, ornW: 30, bandBg: '#EFE9FB',
  },
  baby: {
    page: '#BFE3F5', card: '#FFFDF7', ink: '#2E4A63', muted: '#62829B',
    accent: '#FFC857', accentInk: '#2E4A63', btn: '#26789F', btnInk: '#FFFFFF', ghost: '#26789F',
    title: '#26789F', font: font('Baloo Bhaijaan 2'), family: 'Baloo Bhaijaan 2', size: 38, weight: 700,
    note: '#E6F4FB', link: '#1F6A8E', error: '#A83B3B', radius: 30, frame: 'none',
    orn: ORN.bubbles('', 36, 14), ornH: 14, ornW: 36, bandBg: '#E6F4FB',
  },
  grad: {
    page: '#FFD60A', card: '#101010', ink: '#F7F7F7', muted: '#BDBDBD',
    accent: '#FFD60A', accentInk: '#101010', btn: '#FFD60A', btnInk: '#101010', ghost: '#FFD60A',
    title: '#FFD60A', font: font('Cairo'), family: 'Cairo', size: 40, weight: 700,
    note: '#1D1D1D', link: '#FFD60A', error: '#FF9D9D', radius: 0, frame: 'none',
    orn: ORN.stripes('#FFD60A', 12, 12), ornH: 12, ornW: 12, bandBg: '#FFD60A',
    bandOrn: ORN.stripes('#101010', 12, 12), bandH: 12, bandW: 12,
  },
};

module.exports = { SHAPES, ORN, THEMES, SANS };
