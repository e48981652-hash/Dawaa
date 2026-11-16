const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createSession(organizerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, organizer_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token), organizerId, expires,
  );
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  const row = db
    .prepare(
      `SELECT s.expires_at, o.id, o.name, o.phone
         FROM sessions s JOIN organizers o ON o.id = s.organizer_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول من جديد' });
  }
  req.org = { id: row.id, name: row.name, phone: row.phone };
  req.token = token;
  next();
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

module.exports = {
  sha256, hashPassword, verifyPassword, createSession, destroySession, requireAuth, purgeExpiredSessions,
};
