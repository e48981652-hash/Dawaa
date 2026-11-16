// قوالب الدعوة. الألوان والخطوط نفسها في public/themes.css (يُولَّد من tools/build-themes.js)؛
// هنا فقط المعرّف والاسم والوصف، ويُعاد استخدامها في التحقق من المدخلات.
const TEMPLATES = [
  { id: 'najd', label: 'نجد', note: 'نيلي وزعفران بزخرفة مثلثات نجدية' },
  { id: 'rose', label: 'ورد', note: 'وردي ناعم وخط ديواني، للأفراح والملكة' },
  { id: 'emerald', label: 'زمرد', note: 'أخضر عميق وذهبي بطابع كلاسيكي' },
  { id: 'royal', label: 'ملكي', note: 'أسود وذهبي بإطار مزدوج فخم' },
  { id: 'pearl', label: 'لؤلؤ', note: 'أبيض هادئ وبسيط وأنيق' },
  { id: 'sand', label: 'رمال', note: 'ألوان الصحراء الدافئة بزخرفة متعرّجة' },
  { id: 'sea', label: 'بحر', note: 'تركوازي منعش وموجات خفيفة' },
  { id: 'lavender', label: 'لافندر', note: 'بنفسجي هادئ وحواف ناعمة' },
  { id: 'baby', label: 'مولود', note: 'ألوان باستيل مرحة لاستقبال المواليد' },
  { id: 'grad', label: 'تخرج', note: 'عصري وجريء بالأسود والأصفر' },
];

const DEFAULT_TEMPLATE = 'najd';
const IDS = new Set(TEMPLATES.map((t) => t.id));

module.exports = {
  TEMPLATES,
  DEFAULT_TEMPLATE,
  isTemplate: (id) => IDS.has(id),
};
