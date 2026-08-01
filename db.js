// server/db.js
// Zero-dependency SQLite layer using Node's built-in `node:sqlite`.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'aditya.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','partner')),
  partner_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  type TEXT NOT NULL DEFAULT 'Partner',
  balance REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL DEFAULT 'Quintal',
  current_rate REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  crop TEXT NOT NULL,
  party_name TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0),
  rate REAL NOT NULL CHECK(rate >= 0),
  total REAL NOT NULL,
  transport REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Paid','Partial','Pending')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  crop TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0),
  rate REAL NOT NULL CHECK(rate >= 0),
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Paid','Partial','Pending')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  qty REAL,
  rate REAL,
  total REAL NOT NULL,
  trade_ref TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// ---- Password hashing (scrypt, built into Node, no deps) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const test = crypto.scryptSync(password, salt, 64);
  return test.length === hash.length && crypto.timingSafeEqual(test, hash);
}

// ---- Seed default data on first run ----
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@adityatrading.co.in';
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const hash = hashPassword(adminPassword);
    db.prepare(`INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')`)
      .run('Admin', adminEmail, hash);

    if (!process.env.ADMIN_PASSWORD) {
      console.log('\n==================================================');
      console.log(' No ADMIN_PASSWORD set in environment.');
      console.log(' Generated a one-time admin password:');
      console.log(` Email:    ${adminEmail}`);
      console.log(` Password: ${adminPassword}`);
      console.log(' Log in once, then create a real admin account and');
      console.log(' remove this generated one. This password will not');
      console.log(' be shown again.');
      console.log('==================================================\n');
    }
  }

  const cropCount = db.prepare('SELECT COUNT(*) AS c FROM crops').get().c;
  if (cropCount === 0) {
    const crops = [
      ['Wheat', 2285], ['Soybean', 4820], ['Chana', 5340],
      ['Maize', 1980], ['Rice', 3150], ['Mustard', 5650]
    ];
    const stmt = db.prepare('INSERT INTO crops (name, current_rate) VALUES (?,?)');
    for (const [name, rate] of crops) stmt.run(name, rate);
  }
}
seed();

module.exports = { db, hashPassword, verifyPassword };
