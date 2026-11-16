// يولّد public/themes.css من src/theme-data.js:  node tools/build-themes.js
const fs = require('fs');
const path = require('path');
const { THEMES } = require('../src/theme-data');

const vars = (t) => [
  ['page', t.page], ['card', t.card], ['ink', t.ink], ['muted', t.muted],
  ['accent', t.accent], ['accent-ink', t.accentInk], ['btn', t.btn], ['btn-ink', t.btnInk], ['ghost', t.ghost],
  ['title', t.title], ['font', t.font], ['size', `${t.size}px`], ['weight', t.weight],
  ['note', t.note], ['link', t.link], ['error', t.error], ['radius', `${t.radius}px`], ['frame', t.frame],
  ['orn', t.orn.uri], ['orn-size', `${t.ornW}px ${t.ornH}px`], ['orn-h', `${t.ornH}px`],
  ['band-bg', t.bandBg],
  ['band-orn', (t.bandOrn || t.orn).uri],
  ['band-size', `${t.bandW || t.ornW}px ${t.bandH || t.ornH}px`],
  ['band-h', `${t.bandH || t.ornH}px`],
].map(([k, v]) => `  --t-${k}: ${v};`).join('\n');

const blocks = Object.entries(THEMES).map(([id, t]) => {
  const sel = id === 'najd' ? ':root,\n[data-theme="najd"]' : `[data-theme="${id}"]`;
  return `${sel} {\n${vars(t)}\n}`;
});

const css = `@charset "UTF-8";
/* مولَّد تلقائياً من tools/build-themes.js — لا تعدّله يدوياً */

${blocks.join('\n\n')}

/* ── تطبيق القالب على بطاقة الدعوة (صفحة الضيف والمعاينة) ── */
body.guest { background: var(--t-page); }
.invite {
  background: var(--t-card); color: var(--t-ink); border-radius: var(--t-radius);
  outline: var(--t-frame); outline-offset: -10px;
}
.invite .muted, .invite .hello, .invite .from, .invite .hijri, .invite .reply .sub { color: var(--t-muted); }
.invite .from b { color: var(--t-ink); }
.invite .title {
  color: var(--t-title); font-family: var(--t-font); font-size: var(--t-size); font-weight: var(--t-weight);
}
.invite .day, .invite .reply h2, .invite .done h2, .invite .error-box h1 { font-family: var(--t-font); color: var(--t-ink); }
.invite .day { font-size: 26px; }
.invite .note, .invite .closed-note { background: var(--t-note); color: var(--t-ink); }
.invite .band {
  height: var(--t-band-h); background-color: var(--t-band-bg);
  background-image: var(--t-band-orn); background-size: var(--t-band-size);
}
.invite .divider { height: var(--t-orn-h); background-image: var(--t-orn); background-size: var(--t-orn-size); }
.invite .btn { background: var(--t-btn); border-color: var(--t-btn); color: var(--t-btn-ink); }
.invite .btn:hover { background: var(--t-btn); filter: brightness(1.12); }
.invite .btn.saffron { background: var(--t-accent); border-color: var(--t-accent); color: var(--t-accent-ink); }
.invite .btn.saffron:hover { background: var(--t-accent); filter: brightness(1.08); }
.invite .btn.ghost { background: transparent; border-color: var(--t-ghost); color: var(--t-ghost); }
.invite .btn.ghost:hover { background: var(--t-note); filter: none; }
.invite .link-btn { color: var(--t-link); }
.invite .stepper button { background: var(--t-card); border-color: var(--t-ghost); color: var(--t-ink); }
.invite .stepper output { font-family: var(--t-font); color: var(--t-ink); }
.invite .check circle { stroke: var(--t-accent); }
.invite .check path { stroke: var(--t-title); }
.invite .form-error { color: var(--t-error); }
.invite :focus-visible { outline-color: var(--t-link); }
@media (max-width: 480px) {
  .invite .title { font-size: calc(var(--t-size) * 0.9); }
}
`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'themes.css'), css);
console.log(`themes.css: ${Object.keys(THEMES).length} قوالب، ${css.length} حرف`);
