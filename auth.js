// server/auth.js
'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = 'atc_session';

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = newToken();
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(tokenHash(token), userId, expires);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.expires_at, u.id, u.name, u.email, u.role, u.partner_id, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(tokenHash(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.active) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, partner_id: row.partner_id };
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token, secure) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`
  ];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res, secure) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// ---- simple in-memory login rate limiter (per email+ip) ----
const attempts = new Map(); // key -> {count, lockedUntil}
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function checkRateLimit(key) {
  const rec = attempts.get(key);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  return { locked: false };
}

function recordFailure(key) {
  const rec = attempts.get(key) || { count: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

function recordSuccess(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE_NAME, createSession, destroySession, getUserFromToken,
  parseCookies, setSessionCookie, clearSessionCookie,
  checkRateLimit, recordFailure, recordSuccess
};
