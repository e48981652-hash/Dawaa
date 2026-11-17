const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./env');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'hayyak.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  organizer_id INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  organizer_id     INTEGER NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'wedding',
  title            TEXT NOT NULL,
  host_line        TEXT NOT NULL DEFAULT '',
  starts_at        TEXT NOT NULL,            -- ISO بتوقيت UTC
  venue            TEXT NOT NULL,
  map_url          TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  template         TEXT NOT NULL DEFAULT 'najd',
  allow_companions INTEGER NOT NULL DEFAULT 1,
  max_companions   INTEGER NOT NULL DEFAULT 3,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(organizer_id);

CREATE TABLE IF NOT EXISTS guests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','declined','maybe')),
  companions       INTEGER NOT NULL DEFAULT 0,
  responded_at     TEXT,
  invite_state     TEXT NOT NULL DEFAULT 'none'
                   CHECK (invite_state IN ('none','queued','sent','failed')),
  invite_sent_at   TEXT,
  invite_error     TEXT,
  reminder_state   TEXT NOT NULL DEFAULT 'none'
                   CHECK (reminder_state IN ('none','queued','sent','failed')),
  reminder_sent_at TEXT,
  reminder_error   TEXT,
  final_status     TEXT,                     -- رد الضيف بعد وصول التذكير
  final_at         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_guests_event ON guests(event_id);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id   INTEGER,
  event_id   INTEGER,
  kind       TEXT NOT NULL,                  -- invite | reminder
  to_phone   TEXT NOT NULL,
  body       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_event ON outbox(event_id);

-- أحداث WAHA الواردة (لمنع المعالجة المزدوجة عند إعادة المحاولة)
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,              -- معرّف الحدث من WAHA
  provider    TEXT NOT NULL,                 -- waha
  event       TEXT NOT NULL,                 -- poll.vote | message | message.ack | session.status
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- حالة جلسة WAHA (صف واحد فقط)
CREATE TABLE IF NOT EXISTS wa_status (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  status     TEXT,
  phone      TEXT,
  updated_at TEXT
);
`);

// ترحيل: قواعد البيانات المنشأة قبل إضافة القوالب
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'template')) {
  db.exec("ALTER TABLE events ADD COLUMN template TEXT NOT NULL DEFAULT 'najd'");
}

// ترحيل: إضافة الأعمدة الجديدة لقواعد البيانات القديمة
function addColumn(table, name, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}
addColumn('events', 'honorees', "TEXT NOT NULL DEFAULT ''");   // أسماء أصحاب المناسبة (العريس والعروس…)
addColumn('events', 'occasion', "TEXT NOT NULL DEFAULT ''");   // عبارة المناسبة: حفل زفاف…
addColumn('guests', 'honorific', "TEXT NOT NULL DEFAULT ''");  // m = المكرم، f = المكرمة، فارغ = الاسم فقط
addColumn('guests', 'invite_delivery', 'TEXT');                // sent | delivered | read | failed (من واتساب)
addColumn('guests', 'reminder_delivery', 'TEXT');
addColumn('outbox', 'channel', "TEXT NOT NULL DEFAULT 'sms'");
addColumn('outbox', 'meta', 'TEXT');                           // JSON: صورة وأزرار رسالة واتساب للمعاينة
addColumn('outbox', 'ext_id', 'TEXT');                         // معرّف الرسالة عند واتساب
addColumn('outbox', 'delivery', 'TEXT');
addColumn('outbox', 'poll_ext_id', 'TEXT');                    // معرّف رسالة الاستفتاء (لمطابقة التصويت)
addColumn('outbox', 'source', 'TEXT');                         // waha | console
addColumn('guests', 'last_inbound_at', 'TEXT');                // آخر ردّ وارد من الضيف
db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_ext ON outbox(ext_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_poll ON outbox(poll_ext_id)');

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = db;
module.exports.transaction = transaction;
