# خطة تكامل واتساب WAHA (WEBJS) — حيّاك · v2

> الحالة: **معتمدة للتنفيذ** · التاريخ: 2026-11-17 · المسؤول: e48981652-hash
> v2 = بعد قرارات العميل: Poll + fallback نصي · خياران للاستفتاء · **إزالة Meta Cloud نهائيًا**

---

## 0) القرارات المعتمدة

| القرار | الاختيار |
|---|---|
| مزوّد واتساب | **WAHA + محرك WEBJS فقط** (Meta Cloud يُزال من الكود) |
| آلية التفاعل | **Poll (استفتاء)** كأساس + **رسالة نصية فيها رابط** كـfallback تلقائي |
| خيارات الاستفتاء | **خياران:** «قبول الدعوة» / «الاعتذار عن الدعوة» (والتذكير: «أؤكد حضوري» / «أعتذر عن الحضور») |
| رابط الموقع | يظهر داخل نص الرسالة (وليس كخيار ثالث) |
| الأوضاع | `WHATSAPP_MODE = console | waha` (لم يعد هناك `cloud`) |
| ضمان الوصول للرد | كل رسالة تحمل رابط صفحة الدعوة `/i/<token>` كشبكة أمان حتى لو فشل الاستفتاء |

---

## 1) الخلاصة

1. WAHA/WEBJS لا تدعم الأزرار التفاعلية (`sendButtons` معلَّم `deprecated` رسميًا)، والبديل المدعوم هو **`sendPoll`**.
2. الإرسال: صورة البطاقة **base64** (من `renderCard` مباشرة) + استفتاء بخيارين → لا حاجة لرابط عام لصورة البطاقة.
3. الاستقبال: Webhook موقَّع **HMAC-SHA512** → `poll.vote` / `message` / `message.ack` / `session.status` → نفس `handleButton()` الحالية → `recordResponse()` → الداتابيز والداشبورد.
4. Meta Cloud يُزال بالكامل: كود + إعدادات + Webhook + اختبارات + توثيق.
5. التقدير: **5 أيام عمل** على 4 مراحل.

---

## 2) لماذا Poll؟ (الدليل)

- وثائق WAHA — قسم Send Buttons:
  > **DEPRECATED — Buttons do not work at the moment!** … We recommend adding fallback logic using **Send Text** or **Polls**.
  > <https://waha.devlike.pro/docs/how-to/send-messages/#send-buttons>
- OpenAPI: `POST /api/sendButtons` → `"deprecated": true`.
- `POST /api/sendPoll` → الوصف الرسمي: *"Send a poll with options — You can use it as buttons or list replacement"*.
- دعم WEBJS: `sendPoll` ✔️ · `poll.vote` ✔️ · `sendImage` ✔️ · `sendText` ✔️ · `message.ack` ✔️ · `sendList` ❌ · Event RSVP ❌.

| المطلوب | الحل المعتمد على WEBJS |
|---|---|
| صورة البطاقة | `sendImage` بـ `file.data` (base64) |
| ضغطة واحدة تسجّل الرد | `sendPoll` + `poll.vote` |
| بديل عند فشل الاستفتاء | `sendText` فيه رابط `/i/<token>` |
| تأكيد للضيف بعد الرد | `sendText` (نفس `replyFor` الحالية) |
| حالات التسليم/القراءة | `message.ack` |

---

## 3) المعمارية

```
المنظّم ──HTTP──▶ حيّاك (Express) ──X-Api-Key──▶ WAHA :3001 (WEBJS) ──▶ واتساب
                    ▲                                   │
                    └──── /webhooks/waha ◀──────────────┘  (HMAC-SHA512)
                                   poll.vote / message / message.ack / session.status
```

### 3.1 الإرسال

```
dispatchInvites()  (بدون تغيير)
  └─ whatsapp.sendTemplate(kind, guest, event)
       └─ WHATSAPP_MODE=waha → waha.sendInvite()
            1) renderCard(...) → PNG → base64
            2) POST /api/sendImage { chatId, file:{mimetype:'image/png', data, filename}, caption }
               caption = نص الدعوة + 📍 الموقع + 🗺️ رابط الخريطة + 🔗 رابط الرد
            3) POST /api/sendPoll { poll:{ name:'تأكيد الحضور', options:['قبول الدعوة','الاعتذار عن الدعوة'], multipleAnswers:false } }
            4) فشل sendPoll → POST /api/sendText بالرابط (fallback) → لو فشل أيضًا: invite_state='failed'
            5) صف واحد في outbox: ext_id=صورة · poll_ext_id=استفتاء · meta={interactive:'poll', options, ...}
```

- `chatId` = `guest.phone + '@c.us'` (الرقم مخزّن بالفعل دوليًا بدون `+`).
- `queued → sent/failed` تبقى كما هي في `dispatch.js` — لا تعديل.
- تباعد 4–7 ثوانٍ بين الرسائل (`WAHA_SEND_DELAY_MS` + jitter) لتقليل خطر الحظر.

### 3.2 الاستقبال (قلب المطلوب)

```
POST /webhooks/waha
  1) تحقق X-Webhook-Hmac (SHA512 على raw body)  → 403 لو فشل
  2) رد 200 فورًا
  3) INSERT INTO webhook_events(id=evt_...)      → لو مكرر: تجاهل
  4) switch body.event:
     ├─ poll.vote      → poll.id → outbox.poll_ext_id → guest
     │                   selectedOptions[0] → action (a/d)
     │                   whatsapp.handleButton(`a:TOKEN`, from)
     ├─ message        → نص: تطبيع + مطابقة (قبول/أعتذر/1/2) → handleButton
     ├─ message.ack    → id → outbox.ext_id → delivery + guests.*_delivery
     └─ session.status → upsert wa_status
  5) logInbound() → outbox(kind='inbound')  ← يظهر في سجل الرسائل بالداشبورد
  6) handleButton() → recordResponse() → guests.status/responded_at/final_status
                    → sendText() تأكيد للضيف
```

### 3.3 خريطة الأحداث

| حدث | الحقول | الإجراء |
|---|---|---|
| `poll.vote` | `poll.id` · `vote.from` · `selectedOptions[0]` | مطابقة `poll_ext_id` → `handleButton('a|d:TOKEN')` |
| `message` (fromMe=false) | `from` · `body` | كلمات مفتاحية → `handleButton`، وإلا تسجيل وارد فقط |
| `message.ack` | `id` · `ackName` | `SERVER→sent` · `DEVICE→delivered` · `READ→read` · `ERROR→failed` |
| `session.status` | `status` | `WORKING / SCAN_QR_CODE / FAILED` في `wa_status` |

### 3.4 تطبيع النص

```
إزالة التشكيل والتطويل والرموز → trim → lowercase
a : قبول | اقبل | أقبل | اؤكد | أؤكد | مؤكد | حاضر | yes | 1
d : اعتذار | اعتذر | أعتذر | معتذر | لن احضر | no | 2
غير ذلك: وارد عادي بلا تغيير حالة
```

> خيار «موقع المناسبة» أُزيل من التفاعل: رابط الخريطة داخل النص، وأي طلب موقع من الضيف كلمةً يُرد عليه تلقائيًا برابط الخريطة دون تغيير حالته (اختياري، سطر واحد).

---

## 4) إزالة Meta Cloud — خريطة التأثير

| ملف | التغيير |
|---|---|
| `src/whatsapp.js` | حذف `post()` · `templatePayload()` · `verifySignature()` · `processWebhook()` · فروع `cloud` · `WHATSAPP_TEMPLATE_*` · `WHATSAPP_LANG` · `WHATSAPP_API_VERSION`. يبقى: `build` · `BUTTONS` · `handleButton` · `replyFor` · `logOutbox` · `configProblems` (تتحول لفحص WAHA) |
| `src/env.js` | حذف `WHATSAPP_TOKEN` · `WHATSAPP_PHONE_ID` · `WHATSAPP_APP_SECRET` · `WHATSAPP_VERIFY_TOKEN` · `WHATSAPP_API_VERSION` · `WHATSAPP_TEMPLATE_*` · `WHATSAPP_LANG`. إضافة متغيرات `WAHA_*`. `WHATSAPP_MODE` تقبل `console|waha` فقط (أي قيمة قديمة `cloud` → `console` + تحذير عند الإقلاع) |
| `server.js` | حذف `GET/POST /webhooks/whatsapp` · حذف تحقق `x-hub-signature-256`. إضافة `POST /webhooks/waha` و`GET /api/waha/status`. تحديث سطر الإقلاع |
| `src/dispatch.js` | لا تغيير |
| `src/messages.js` | لا تغيير (النصوص تُستخدم كـ caption) |
| `public/app.js` | `KIND_MSG.inbound` · عرض خيارات الاستفتاء · فقاعة وارد · شارة الحالة · polling أثناء فتح السجل |
| `test/whatsapp.test.js` | يُعاد كتابته → `test/waha.test.js` (إزالة كل اختبارات Meta: template payload / hub.challenge / app secret) |
| `test/e2e.test.js` | يبقى على `WHATSAPP_MODE=console` — تحقق فقط من عدم تأثره |
| `README.md` | حذف قسم Meta بالكامل (سطور ~39–128) واستبداله بدليل WAHA: Docker · QR · Webhook · poll · حدود الأزرار |
| `.env.example` | قسم واتساب جديد بـ `WAHA_*` فقط |
| `package.json` | لا تغيير في الاعتماديات (كل شيء عبر `fetch` المدمج) |

> **سلامة الترقية:** أي تنصيب قديم على `WHATSAPP_MODE=cloud` سيهبط إلى `console` مع تحذير واضح في اللوج، بدل أن يتعطل.

---

## 5) قاعدة البيانات (ترحيلات بنمط `addColumn` الموجود)

```sql
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,          -- evt_... (أو X-Webhook-Request-Id)
  provider    TEXT NOT NULL,             -- waha
  event       TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wa_status (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  status     TEXT,
  phone      TEXT,
  updated_at TEXT
);

ALTER TABLE outbox ADD COLUMN poll_ext_id TEXT;
ALTER TABLE outbox ADD COLUMN source TEXT;          -- waha | console | page
CREATE INDEX IF NOT EXISTS idx_outbox_poll ON outbox(poll_ext_id);
ALTER TABLE guests ADD COLUMN last_inbound_at TEXT;
```

`outbox.kind` الجديدة: `inbound` (رد وارد). القيم الحالية `invite|reminder|reply` تبقى.

---

## 6) الإعدادات الجديدة (`.env.example`)

```ini
# ── قناة الدعوات: whatsapp | sms ──
INVITE_CHANNEL=whatsapp

# ── واتساب: console (معاينة) | waha (إرسال فعلي) ──
WHATSAPP_MODE=waha

# WAHA — محرك WEBJS
WAHA_BASE_URL=http://127.0.0.1:3001
WAHA_API_KEY=مفتاح-طويل-عشوائي
WAHA_SESSION=default
WAHA_WEBHOOK_HMAC_KEY=سر-آخر-طويل
WAHA_SEND_DELAY_MS=4000
WAHA_SEND_JITTER_MS=3000
```

- `PUBLIC_BASE_URL` لازم يكون **رابطًا يصل إليه الضيف** (https في الإنتاج) لأن الروابط وQR داخل البطاقة تشير إليه. **صورة البطاقة لا تحتاج رابطًا عامًا** بعد الآن (base64).
- للتجربة المحلية على جوالك: نفق (cloudflared/ngrok) وضبط `PUBLIC_BASE_URL` عليه.

---

## 7) التشغيل

```yaml
services:
  waha:
    image: devlikeapro/waha:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3000"            # غير مكشوف للإنترنت
    environment:
      WHATSAPP_DEFAULT_ENGINE: WEBJS
      WHATSAPP_API_KEY: ${WAHA_API_KEY}
      WHATSAPP_HOOK_URL: http://host.docker.internal:3000/webhooks/waha
      WHATSAPP_HOOK_EVENTS: message,poll.vote,message.ack,session.status
      WHATSAPP_HOOK_HMAC_KEY: ${WAHA_WEBHOOK_HMAC_KEY}
      WHATSAPP_HOOK_RETRIES_ATTEMPTS: 10
    volumes:
      - ./waha-sessions:/app/.sessions   # تبقى الجلسة بعد إعادة التشغيل
```

- المسح: `http://127.0.0.1:3001/dashboard` ← QR ← جوال الرقم المخصص.
- تحقق `healthz` + `GET /api/{session}` قبل أي إرسال.

---

## 8) الداشبورد

- **شارة حالة** أعلى المناسبة: `متصل` / `بانتظار QR` / `متوقف` من `/api/waha/status`.
- **سجل الرسائل**:
  - الدعوة تظهر كما هي (صورة + نص) + chips لخياري الاستفتاء.
  - الرد الوارد يظهر كفقاعة داخلة: «رد وارد — قبول الدعوة» مع التوقيت.
  - حالة التسليم/القراءة بجانب كل رسالة (من `message.ack`).
- تحديث تلقائي كل 10 ثوانٍ **أثناء فتح السجل فقط** + عند `visibilitychange`.
- وضع `console` يبقى كما هو مع أزرار المعاينة (لا يتأثر).

---

## 9) الأمان ومكافحة الحظر

| بند | إجراء |
|---|---|
| WAHA | `127.0.0.1` فقط + `X-Api-Key` قوي |
| Webhook | HMAC-SHA512 + `timingSafeEqual` + رفض غير الموقَّع |
| التكرار | `webhook_events` بمفتاح أساسي على `evt_...` |
| الحظر | تباعد + jitter · رقم مخصص + warm-up · إيقاف عند `463/475` · حد يومي إعدادي |
| أرقام غير مسجّلة | `checkNumberStatus` قبل الإرسال → `failed` برسالة مفهومة |
| الخصوصية | لا أرقام كاملة في اللوج · رموز الدعوة عشوائية |

---

## 10) الاختبارات

`test/waha.test.js` (بديل `whatsapp.test.js`) بخادم WAHA وهمي:
1. إرسال دعوة → طلبان `sendImage` + `sendPoll` → صف `outbox` فيه `ext_id` و`poll_ext_id` و`meta.options`.
2. فشل `sendPoll` → `sendText` fallback → `invite_state='sent'` و`meta.fallback=true`.
3. Webhook بتوقيع خاطئ → 403 ولا تغيير.
4. `poll.vote` «قبول الدعوة» → `accepted` + `responded_at` + صف `inbound`.
5. نفس الحدث مرتين → لا تغيير (idempotency).
6. `message` «أعتذر» → `declined`.
7. `message.ack READ` → `outbox.delivery='read'` و`guests.invite_delivery='read'`.
8. `GET /outbox` يرجع `inbound` للداشبورد.
9. وضع `console` ما زال يعمل (اختبارات e2e الحالية).

### قائمة تحقق يدوية
- [ ] QR → `WORKING`.
- [ ] دعوة لرقمك: صورة + استفتاء.
- [ ] «قبول الدعوة» → الحالة في الداشبورد ≤ 10 ثوانٍ + رسالة شكر.
- [ ] «الاعتذار» → `declined`.
- [ ] إعادة تشغيل السيرفر: الحالة والجلسة باقيتان.
- [ ] إعادة تشغيل WAHA: الجلسة تعود `WORKING` تلقائيًا.

---

## 11) المخاطر

| خطر | تخفيف |
|---|---|
| حظر رقم واتساب (غير رسمي) | تباعد + warm-up + حد يومي + رقم مخصص |
| تغيّر شكل `poll.vote` بين إصدارات WAHA | طبقة `src/waha.js` معزولة + اختبارات عقد |
| عدم وصول `message.ack` لكل الحالات | الحالة النهائية للضيف لا تعتمد عليه — تُحدَّث من `poll.vote` |
| ضياع Webhook عند توقف السيرفر | WAHA يعيد المحاولة 10 مرات + `webhook_events` |
| Docker غير متاح | WAHA على VPS منفصل + HTTPS |

---

## 12) خطة التنفيذ

| المرحلة | المحتوى | التقدير |
|---|---|---|
| **M1 — WAHA client** | `env.js` + `src/waha.js` (sendImage base64 · sendPoll · sendText · checkNumber) + façade `whatsapp.js` + `outbox.meta` | 1.5 يوم |
| **M2 — Webhook** | `/webhooks/waha` + HMAC + idempotency + poll.vote/message/ack/status + `logInbound` | 1.5 يوم |
| **M3 — إزالة Meta + الداشبورد** | حذف كل مسارات Meta وأكوادها + README + واجهة الداشبورد (chips/وارد/شارة/polling) | 1 يوم |
| **M4 — تثبيت** | `test/waha.test.js` + Docker + قائمة التحقق اليدوية | 1 يوم |
| | **الإجمالي** | **5 أيام** |

---

## 13) ما لا يتغيّر

- صفحة الضيف `/i/:token` · `recordResponse` · تصدير CSV · المجدول · القوالب العشرة · وضع `console`.
- هوية الكوميتات: `e48981652-hash <e48981652@gmail.com>`.
