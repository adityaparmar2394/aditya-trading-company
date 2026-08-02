// server/server.js
// Zero-dependency Node HTTP server (no Express) for Aditya Trading Company.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword } = require('./db');
const auth = require('./auth');
const { writeXlsx, readXlsx, toCsv, parseCsv } = require('./xlsx');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = __dirname;
const MAX_BODY = 8 * 1024 * 1024; // 8MB (covers xlsx uploads)

// ---------------- helpers ----------------
function send(res, status, body, headers) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuffer ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(payload);
}
function json(res, status, obj) { send(res, status, obj); }
function badRequest(res, msg) { json(res, 400, { error: msg }); }
function unauthorized(res, msg) { json(res, 401, { error: msg || 'Unauthorized' }); }
function forbidden(res, msg) { json(res, 403, { error: msg || 'Forbidden' }); }
function notFound(res, msg) { json(res, 404, { error: msg || 'Not found' }); }
function serverError(res, err) {
  console.error(err);
  json(res, 500, { error: 'Internal server error' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}

function getSessionUser(req) {
  const cookies = auth.parseCookies(req);
  return auth.getUserFromToken(cookies[auth.COOKIE_NAME]);
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) { unauthorized(res); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { forbidden(res, 'Admin access required'); return null; }
  return user;
}
// Basic CSRF mitigation for state-changing requests: require this custom
// header (browsers block cross-site scripts from setting custom headers on
// simple requests, and our fetch client always sends it).
function requireSameOrigin(req, res) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.headers['x-requested-with'] !== 'atc-frontend') {
      forbidden(res, 'Missing required header');
      return false;
    }
  }
  return true;
}

function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isPosNum(n) { return typeof n === 'number' && isFinite(n) && n >= 0; }
function num(v, def) { const n = Number(v); return isFinite(n) ? n : def; }

// ---------------- rows -> generic helpers ----------------
function rowsOf(sql, params = []) { return db.prepare(sql).all(...params); }
function oneOf(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

// ================================================================
// AUTH ROUTES
// ================================================================
async function handleLogin(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return badRequest(res, 'Email and password are required');

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `${email}:${ip}`;
  const rl = auth.checkRateLimit(rlKey);
  if (rl.locked) {
    return json(res, 429, { error: `Too many failed attempts. Try again in ${Math.ceil(rl.retryAfterMs / 60000)} minute(s).` });
  }

  const user = oneOf('SELECT * FROM users WHERE email = ? AND active = 1', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    auth.recordFailure(rlKey);
    return unauthorized(res, 'Invalid email or password');
  }
  auth.recordSuccess(rlKey);
  const { token } = auth.createSession(user.id);
  auth.setSessionCookie(res, token, IS_PROD);
  json(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

async function handleLogout(req, res) {
  const cookies = auth.parseCookies(req);
  auth.destroySession(cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(res, IS_PROD);
  json(res, 200, { ok: true });
}

function handleMe(req, res) {
  const user = getSessionUser(req);
  if (!user) return unauthorized(res);
  json(res, 200, { user });
}

// ================================================================
// CROPS / RATES
// ================================================================
function handleCrops(req, res) {
  json(res, 200, { crops: rowsOf('SELECT * FROM crops ORDER BY name') });
}

// ================================================================
// PURCHASES
// ================================================================
function computeStatus(s) {
  const allowed = ['Paid', 'Partial', 'Pending'];
  return allowed.includes(s) ? s : 'Pending';
}

function validatePSFields(body, isSale) {
  const errors = [];
  if (!isValidDate(body.date)) errors.push('date must be YYYY-MM-DD');
  if (!body.crop || typeof body.crop !== 'string') errors.push('crop is required');
  const party = isSale ? body.buyer_name : body.party_name;
  if (!party || typeof party !== 'string') errors.push(isSale ? 'buyer_name is required' : 'party_name is required');
  const qty = num(body.qty, NaN);
  if (!isFinite(qty) || qty <= 0) errors.push('qty must be a positive number');
  const rate = num(body.rate, NaN);
  if (!isFinite(rate) || rate < 0) errors.push('rate must be a non-negative number');
  if (body.stored_in && !['ATC', 'NCML', 'Mandi', ''].includes(body.stored_in)) errors.push('stored_in must be ATC, NCML, or Mandi');
  if (body.mandi_portal && !['Y', 'N', ''].includes(body.mandi_portal)) errors.push('mandi_portal must be Y or N');
  if (body.source && !['URD', 'Mandi', 'B2B', ''].includes(body.source)) errors.push('source must be URD, Mandi, or B2B');
  if (body.billed_qty !== undefined && body.billed_qty !== null && body.billed_qty !== '' && !isFinite(num(body.billed_qty, NaN))) errors.push('billed_qty must be a number');
  if (body.billed_rate !== undefined && body.billed_rate !== null && body.billed_rate !== '' && !isFinite(num(body.billed_rate, NaN))) errors.push('billed_rate must be a number');
  return errors;
}

function pickExtraFields(body) {
  const norm = (v, allowed) => {
    const s = String(v ?? '').trim();
    const hit = allowed.find(a => a.toLowerCase() === s.toLowerCase());
    return hit || '';
  };
  return {
    stored_in: norm(body.stored_in, ['ATC', 'NCML', 'Mandi']),
    mandi_portal: norm(body.mandi_portal, ['Y', 'N']),
    source: norm(body.source, ['URD', 'Mandi', 'B2B']),
    billed_qty: body.billed_qty !== undefined && body.billed_qty !== null && body.billed_qty !== '' ? num(body.billed_qty, null) : null,
    billed_rate: body.billed_rate !== undefined && body.billed_rate !== null && body.billed_rate !== '' ? num(body.billed_rate, null) : null,
    himmali: num(body.himmali, 0),
    tulai: num(body.tulai, 0)
  };
}

async function handleCreatePurchase(req, res, user) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const errors = validatePSFields(body, false);
  if (errors.length) return badRequest(res, errors.join('; '));
  const qty = num(body.qty, 0), rate = num(body.rate, 0), transport = num(body.transport, 0);
  const total = qty * rate;
  const ex = pickExtraFields(body);
  const info = run(
    `INSERT INTO purchases (date, crop, party_name, qty, rate, total, transport, status, stored_in, mandi_portal, source, billed_qty, billed_rate, himmali, tulai, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.date, body.crop.trim(), body.party_name.trim(), qty, rate, total, transport, computeStatus(body.status),
     ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, user.id]
  );
  json(res, 201, { purchase: oneOf('SELECT * FROM purchases WHERE id = ?', [info.lastInsertRowid]) });
}

function handleListPurchases(req, res, query) {
  let sql = 'SELECT * FROM purchases WHERE 1=1';
  const params = [];
  if (query.from) { sql += ' AND date >= ?'; params.push(query.from); }
  if (query.to) { sql += ' AND date <= ?'; params.push(query.to); }
  if (query.crop) { sql += ' AND crop = ?'; params.push(query.crop); }
  sql += ' ORDER BY date DESC, id DESC';
  json(res, 200, { purchases: rowsOf(sql, params) });
}

async function handleUpdatePurchase(req, res, id) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const existing = oneOf('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  const merged = { ...existing, ...body };
  const errors = validatePSFields(merged, false);
  if (errors.length) return badRequest(res, errors.join('; '));
  const qty = num(merged.qty, 0), rate = num(merged.rate, 0), transport = num(merged.transport, 0);
  const total = qty * rate;
  const ex = pickExtraFields(merged);
  run(`UPDATE purchases SET date=?, crop=?, party_name=?, qty=?, rate=?, total=?, transport=?, status=?, stored_in=?, mandi_portal=?, source=?, billed_qty=?, billed_rate=?, himmali=?, tulai=? WHERE id=?`,
    [merged.date, merged.crop.trim(), merged.party_name.trim(), qty, rate, total, transport, computeStatus(merged.status),
     ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, id]);
  json(res, 200, { purchase: oneOf('SELECT * FROM purchases WHERE id = ?', [id]) });
}

function handleDeletePurchase(req, res, id) {
  const existing = oneOf('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('DELETE FROM purchases WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// SALES
// ================================================================
async function handleCreateSale(req, res, user) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const errors = validatePSFields(body, true);
  if (errors.length) return badRequest(res, errors.join('; '));
  const qty = num(body.qty, 0), rate = num(body.rate, 0);
  const total = qty * rate;

  // profit = sale total - avg purchase cost for same crop (weighted avg of stock)
  const profit = computeSaleProfit(body.crop, qty, total);
  const ex = pickExtraFields(body);

  const info = run(
    `INSERT INTO sales (date, crop, buyer_name, qty, rate, total, status, stored_in, mandi_portal, source, billed_qty, billed_rate, himmali, tulai, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [body.date, body.crop.trim(), body.buyer_name.trim(), qty, rate, total, computeStatus(body.status),
     ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, user.id]
  );
  const sale = oneOf('SELECT * FROM sales WHERE id = ?', [info.lastInsertRowid]);
  sale.profit = profit;
  json(res, 201, { sale });
}

function computeSaleProfit(crop, saleQty, saleTotal) {
  const p = oneOf(`SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(total+transport),0) AS c FROM purchases WHERE crop = ?`, [crop]);
  const s = oneOf(`SELECT COALESCE(SUM(qty),0) AS q FROM sales WHERE crop = ?`, [crop]);
  if (!p.q) return null;
  const avgCost = p.c / p.q;
  return Math.round((saleTotal - avgCost * saleQty) * 100) / 100;
}

function handleListSales(req, res, query) {
  let sql = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if (query.from) { sql += ' AND date >= ?'; params.push(query.from); }
  if (query.to) { sql += ' AND date <= ?'; params.push(query.to); }
  if (query.crop) { sql += ' AND crop = ?'; params.push(query.crop); }
  sql += ' ORDER BY date DESC, id DESC';
  const sales = rowsOf(sql, params);
  sales.forEach(s => { s.profit = computeSaleProfit(s.crop, s.qty, s.total); });
  json(res, 200, { sales });
}

async function handleUpdateSale(req, res, id) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const existing = oneOf('SELECT * FROM sales WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  const merged = { ...existing, ...body };
  const errors = validatePSFields(merged, true);
  if (errors.length) return badRequest(res, errors.join('; '));
  const qty = num(merged.qty, 0), rate = num(merged.rate, 0);
  const total = qty * rate;
  const ex = pickExtraFields(merged);
  run(`UPDATE sales SET date=?, crop=?, buyer_name=?, qty=?, rate=?, total=?, status=?, stored_in=?, mandi_portal=?, source=?, billed_qty=?, billed_rate=?, himmali=?, tulai=? WHERE id=?`,
    [merged.date, merged.crop.trim(), merged.buyer_name.trim(), qty, rate, total, computeStatus(merged.status),
     ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, id]);
  const sale = oneOf('SELECT * FROM sales WHERE id = ?', [id]);
  sale.profit = computeSaleProfit(sale.crop, sale.qty, sale.total);
  json(res, 200, { sale });
}

function handleDeleteSale(req, res, id) {
  const existing = oneOf('SELECT * FROM sales WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('DELETE FROM sales WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// STOCK (derived, always in sync — never stored redundantly)
// ================================================================
function handleStock(req, res) {
  const crops = rowsOf('SELECT name FROM crops ORDER BY name');
  const locations = ['ATC', 'NCML', 'Mandi'];
  const stock = crops.map(c => {
    const p = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM purchases WHERE crop = ?', [c.name]);
    const s = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM sales WHERE crop = ?', [c.name]);
    const byLocation = {};
    locations.forEach(loc => {
      const lp = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM purchases WHERE crop = ? AND stored_in = ?', [c.name, loc]);
      const ls = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM sales WHERE crop = ? AND stored_in = ?', [c.name, loc]);
      byLocation[loc] = Math.round((lp.q - ls.q) * 100) / 100;
    });
    // purchases/sales with no location tagged (legacy rows or "not specified")
    const untaggedP = oneOf("SELECT COALESCE(SUM(qty),0) AS q FROM purchases WHERE crop = ? AND (stored_in IS NULL OR stored_in = '')", [c.name]);
    const untaggedS = oneOf("SELECT COALESCE(SUM(qty),0) AS q FROM sales WHERE crop = ? AND (stored_in IS NULL OR stored_in = '')", [c.name]);
    byLocation['Unspecified'] = Math.round((untaggedP.q - untaggedS.q) * 100) / 100;
    return { crop: c.name, purchased: p.q, sold: s.q, inStock: Math.round((p.q - s.q) * 100) / 100, byLocation };
  });
  json(res, 200, { stock });
}

// ================================================================
// EXPENSES
// ================================================================
async function handleCreateExpense(req, res, user) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const errors = [];
  if (!isValidDate(body.date)) errors.push('date must be YYYY-MM-DD');
  if (!body.category || typeof body.category !== 'string') errors.push('category is required');
  const total = num(body.total, NaN);
  if (!isFinite(total) || total < 0) errors.push('total must be a non-negative number');
  if (errors.length) return badRequest(res, errors.join('; '));
  const info = run(
    `INSERT INTO expenses (date, category, description, qty, rate, total, trade_ref, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [body.date, body.category.trim(), body.description || '', body.qty ?? null, body.rate ?? null, total, body.trade_ref || '', user.id]
  );
  json(res, 201, { expense: oneOf('SELECT * FROM expenses WHERE id = ?', [info.lastInsertRowid]) });
}

function handleListExpenses(req, res, query) {
  let sql = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];
  if (query.from) { sql += ' AND date >= ?'; params.push(query.from); }
  if (query.to) { sql += ' AND date <= ?'; params.push(query.to); }
  sql += ' ORDER BY date DESC, id DESC';
  json(res, 200, { expenses: rowsOf(sql, params) });
}

function handleDeleteExpense(req, res, id) {
  const existing = oneOf('SELECT * FROM expenses WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('DELETE FROM expenses WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// PARTNERS
// ================================================================
async function handleCreatePartner(req, res) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  if (!body.name || typeof body.name !== 'string') return badRequest(res, 'name is required');
  const info = run(
    `INSERT INTO partners (name, phone, email, type, balance, notes) VALUES (?,?,?,?,?,?)`,
    [body.name.trim(), body.phone || '', body.email || '', body.type || 'Partner', num(body.balance, 0), body.notes || '']
  );
  json(res, 201, { partner: oneOf('SELECT * FROM partners WHERE id = ?', [info.lastInsertRowid]) });
}
function handleListPartners(req, res) {
  json(res, 200, { partners: rowsOf('SELECT * FROM partners ORDER BY name') });
}
async function handleUpdatePartner(req, res, id) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const existing = oneOf('SELECT * FROM partners WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  const merged = { ...existing, ...body };
  run(`UPDATE partners SET name=?, phone=?, email=?, type=?, balance=?, notes=? WHERE id=?`,
    [merged.name, merged.phone, merged.email, merged.type, num(merged.balance, 0), merged.notes, id]);
  json(res, 200, { partner: oneOf('SELECT * FROM partners WHERE id = ?', [id]) });
}
function handleDeletePartner(req, res, id) {
  const existing = oneOf('SELECT * FROM partners WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('DELETE FROM partners WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// NOTIFICATIONS
// ================================================================
function handleListNotifications(req, res) {
  json(res, 200, { notifications: rowsOf('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50') });
}
function handleMarkNotificationRead(req, res, id) {
  run('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// DASHBOARD / REPORTS (always computed live from the ledger tables)
// ================================================================
function monthKey(dateStr) { return dateStr ? dateStr.slice(0, 7) : ''; }

function handleDashboard(req, res) {
  const rev = oneOf('SELECT COALESCE(SUM(total),0) AS v FROM sales').v;
  const exp = oneOf('SELECT COALESCE(SUM(total),0) AS v FROM expenses').v;
  const purchaseCost = oneOf('SELECT COALESCE(SUM(total+transport),0) AS v FROM purchases').v;
  // Net profit = sum of per-sale profit (sale price - weighted avg purchase cost) - expenses
  const sales = rowsOf('SELECT * FROM sales');
  let salesProfit = 0;
  sales.forEach(s => { const p = computeSaleProfit(s.crop, s.qty, s.total); if (p !== null) salesProfit += p; });
  const netProfit = salesProfit - exp;

  const pending = oneOf(`
    SELECT
      (SELECT COALESCE(SUM(total),0) FROM purchases WHERE status != 'Paid') +
      (SELECT COALESCE(SUM(total),0) FROM sales WHERE status != 'Paid') AS v`).v;
  const pendingCount = oneOf(`
    SELECT
      (SELECT COUNT(*) FROM purchases WHERE status != 'Paid') +
      (SELECT COUNT(*) FROM sales WHERE status != 'Paid') AS c`).c;

  const recentPurchases = rowsOf("SELECT *, 'purchase' AS kind FROM purchases ORDER BY date DESC, id DESC LIMIT 10");
  const recentSales = rowsOf("SELECT *, 'sale' AS kind FROM sales ORDER BY date DESC, id DESC LIMIT 10");
  const recent = [...recentPurchases, ...recentSales]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
    .slice(0, 10);

  // last 6 months revenue vs expenses
  const allSales = rowsOf('SELECT date, total FROM sales');
  const allExpenses = rowsOf('SELECT date, total FROM expenses');
  const allPurchaseCosts = rowsOf('SELECT date, total, transport FROM purchases');
  const months = {};
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.toISOString().slice(0, 7);
    months[key] = { month: key, revenue: 0, expenses: 0 };
  }
  allSales.forEach(s => { const k = monthKey(s.date); if (months[k]) months[k].revenue += s.total; });
  allExpenses.forEach(e => { const k = monthKey(e.date); if (months[k]) months[k].expenses += e.total; });
  allPurchaseCosts.forEach(p => { const k = monthKey(p.date); if (months[k]) months[k].expenses += (p.total + p.transport); });

  json(res, 200, {
    kpis: {
      totalRevenue: rev,
      totalExpenses: exp + purchaseCost,
      netProfit,
      pendingAmount: pending,
      pendingCount
    },
    recentTransactions: recent,
    monthlyChart: Object.values(months)
  });
}

function handleReports(req, res, query) {
  const from = query.from || '1970-01-01';
  const to = query.to || '9999-12-31';
  const purchases = rowsOf('SELECT * FROM purchases WHERE date BETWEEN ? AND ?', [from, to]);
  const sales = rowsOf('SELECT * FROM sales WHERE date BETWEEN ? AND ?', [from, to]);
  const expenses = rowsOf('SELECT * FROM expenses WHERE date BETWEEN ? AND ?', [from, to]);

  const totalPurchases = purchases.reduce((a, p) => a + p.total + p.transport, 0);
  const totalSales = sales.reduce((a, s) => a + s.total, 0);
  const totalExpenses = expenses.reduce((a, e) => a + e.total, 0);

  const byCrop = {};
  purchases.forEach(p => { byCrop[p.crop] = byCrop[p.crop] || { crop: p.crop, purchased: 0, sold: 0, purchaseCost: 0, saleRevenue: 0 }; byCrop[p.crop].purchased += p.qty; byCrop[p.crop].purchaseCost += p.total + p.transport; });
  sales.forEach(s => { byCrop[s.crop] = byCrop[s.crop] || { crop: s.crop, purchased: 0, sold: 0, purchaseCost: 0, saleRevenue: 0 }; byCrop[s.crop].sold += s.qty; byCrop[s.crop].saleRevenue += s.total; });

  json(res, 200, {
    range: { from, to },
    totals: { purchases: totalPurchases, sales: totalSales, expenses: totalExpenses, netProfit: totalSales - totalPurchases - totalExpenses },
    byCrop: Object.values(byCrop),
    purchases, sales, expenses
  });
}

// ================================================================
// EXPORT (.xlsx and .csv)
// ================================================================
function handleExport(req, res, query) {
  const type = query.type || 'purchases';
  const format = query.format || 'xlsx';
  let headers, rows, filename;

  if (type === 'purchases') {
    headers = ['Date', 'Crop', 'Party', 'Qty (Q)', 'Rate/Q', 'Total', 'Transport', 'Status', 'Stored In', 'Mandi Portal', 'Source', 'Billed Qty', 'Billed Rate', 'Himmali', 'Tulai'];
    rows = rowsOf('SELECT * FROM purchases ORDER BY date DESC').map(p => [p.date, p.crop, p.party_name, p.qty, p.rate, p.total, p.transport, p.status, p.stored_in, p.mandi_portal, p.source, p.billed_qty, p.billed_rate, p.himmali, p.tulai]);
    filename = 'purchases';
  } else if (type === 'sales') {
    headers = ['Date', 'Crop', 'Buyer', 'Qty (Q)', 'Rate/Q', 'Total', 'Status', 'Stored In', 'Mandi Portal', 'Source', 'Billed Qty', 'Billed Rate', 'Himmali', 'Tulai'];
    rows = rowsOf('SELECT * FROM sales ORDER BY date DESC').map(s => [s.date, s.crop, s.buyer_name, s.qty, s.rate, s.total, s.status, s.stored_in, s.mandi_portal, s.source, s.billed_qty, s.billed_rate, s.himmali, s.tulai]);
    filename = 'sales';
  } else if (type === 'expenses') {
    headers = ['Date', 'Category', 'Description', 'Qty', 'Rate', 'Total', 'Trade Ref'];
    rows = rowsOf('SELECT * FROM expenses ORDER BY date DESC').map(e => [e.date, e.category, e.description, e.qty, e.rate, e.total, e.trade_ref]);
    filename = 'expenses';
  } else if (type === 'stock') {
    const crops = rowsOf('SELECT name FROM crops ORDER BY name');
    headers = ['Crop', 'Purchased (Q)', 'Sold (Q)', 'In Stock (Q)'];
    rows = crops.map(c => {
      const p = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM purchases WHERE crop=?', [c.name]).q;
      const s = oneOf('SELECT COALESCE(SUM(qty),0) AS q FROM sales WHERE crop=?', [c.name]).q;
      return [c.name, p, s, p - s];
    });
    filename = 'stock';
  } else {
    return badRequest(res, 'Unknown export type');
  }

  if (format === 'csv') {
    const csv = toCsv(headers, rows);
    return send(res, 200, Buffer.from(csv, 'utf8'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`
    });
  }
  const buf = writeXlsx([{ name: filename.slice(0, 31), headers, rows }]);
  send(res, 200, buf, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}.xlsx"`
  });
}

// ================================================================
// IMPORT (.xlsx / .csv) — deterministic column-mapped import.
// Expected headers (case-insensitive), sheet-agnostic:
//   Purchases: date, crop, party, qty, rate, transport, status
//   Sales:     date, crop, buyer, qty, rate, status
//   Expenses:  date, category, description, qty, rate, total, trade_ref
// ================================================================
function normHeader(h) { return String(h || '').trim().toLowerCase(); }

function mapRows(headers, dataRows) {
  const idx = {};
  headers.forEach((h, i) => { idx[normHeader(h)] = i; });
  return { idx, dataRows };
}

async function handleImport(req, res, user, query) {
  const contentType = req.headers['content-type'] || '';
  const buf = await readBody(req);
  if (!buf.length) return badRequest(res, 'No file uploaded');

  const importType = query.type; // 'purchases' | 'sales' | 'expenses'
  if (!['purchases', 'sales', 'expenses'].includes(importType)) {
    return badRequest(res, 'type query param must be purchases, sales, or expenses');
  }

  let table;
  try {
    if (contentType.includes('text/csv') || query.format === 'csv') {
      table = parseCsv(buf.toString('utf8'));
    } else {
      table = readXlsx(buf);
    }
  } catch (e) {
    return badRequest(res, 'Could not parse file: ' + e.message);
  }

  if (!table.length) return badRequest(res, 'File has no rows');
  const headers = table[0];
  const dataRows = table.slice(1).filter(r => r.some(c => c !== '' && c !== undefined));
  const { idx } = mapRows(headers, dataRows);

  const results = { inserted: 0, skipped: 0, errors: [] };

  const insertPurchase = db.prepare(`INSERT INTO purchases (date, crop, party_name, qty, rate, total, transport, status, stored_in, mandi_portal, source, billed_qty, billed_rate, himmali, tulai, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertSale = db.prepare(`INSERT INTO sales (date, crop, buyer_name, qty, rate, total, status, stored_in, mandi_portal, source, billed_qty, billed_rate, himmali, tulai, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertExpense = db.prepare(`INSERT INTO expenses (date, category, description, qty, rate, total, trade_ref, created_by) VALUES (?,?,?,?,?,?,?,?)`);

  dataRows.forEach((row, i) => {
    try {
      if (importType === 'purchases') {
        const date = String(row[idx['date']] ?? '').trim();
        const crop = String(row[idx['crop']] ?? '').trim();
        const party = String(row[idx['party']] ?? row[idx['party_name']] ?? '').trim();
        const qty = num(row[idx['qty']], NaN);
        const rate = num(row[idx['rate']], NaN);
        const transport = num(row[idx['transport']], 0);
        const status = computeStatus(String(row[idx['status']] ?? 'Pending').trim());
        const ex = pickExtraFields({
          stored_in: row[idx['stored_in']] ?? row[idx['stored in']],
          mandi_portal: row[idx['mandi_portal']] ?? row[idx['mandi portal']],
          source: row[idx['source']],
          billed_qty: row[idx['billed_qty']] ?? row[idx['billed qty']],
          billed_rate: row[idx['billed_rate']] ?? row[idx['billed rate']],
          himmali: row[idx['himmali']],
          tulai: row[idx['tulai']]
        });
        if (!isValidDate(date) || !crop || !party || !isFinite(qty) || qty <= 0 || !isFinite(rate) || rate < 0) {
          throw new Error('missing/invalid required fields');
        }
        insertPurchase.run(date, crop, party, qty, rate, qty * rate, transport, status,
          ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, user.id);
      } else if (importType === 'sales') {
        const date = String(row[idx['date']] ?? '').trim();
        const crop = String(row[idx['crop']] ?? '').trim();
        const buyer = String(row[idx['buyer']] ?? row[idx['buyer_name']] ?? '').trim();
        const qty = num(row[idx['qty']], NaN);
        const rate = num(row[idx['rate']], NaN);
        const status = computeStatus(String(row[idx['status']] ?? 'Pending').trim());
        const ex = pickExtraFields({
          stored_in: row[idx['stored_in']] ?? row[idx['stored in']],
          mandi_portal: row[idx['mandi_portal']] ?? row[idx['mandi portal']],
          source: row[idx['source']],
          billed_qty: row[idx['billed_qty']] ?? row[idx['billed qty']],
          billed_rate: row[idx['billed_rate']] ?? row[idx['billed rate']],
          himmali: row[idx['himmali']],
          tulai: row[idx['tulai']]
        });
        if (!isValidDate(date) || !crop || !buyer || !isFinite(qty) || qty <= 0 || !isFinite(rate) || rate < 0) {
          throw new Error('missing/invalid required fields');
        }
        insertSale.run(date, crop, buyer, qty, rate, qty * rate, status,
          ex.stored_in, ex.mandi_portal, ex.source, ex.billed_qty, ex.billed_rate, ex.himmali, ex.tulai, user.id);
      } else {
        const date = String(row[idx['date']] ?? '').trim();
        const category = String(row[idx['category']] ?? '').trim();
        const description = String(row[idx['description']] ?? '');
        const qty = row[idx['qty']] !== undefined ? num(row[idx['qty']], null) : null;
        const rate = row[idx['rate']] !== undefined ? num(row[idx['rate']], null) : null;
        let total = num(row[idx['total']], NaN);
        if (!isFinite(total) && qty && rate) total = qty * rate;
        const tradeRef = String(row[idx['trade_ref']] ?? row[idx['trade']] ?? '');
        if (!isValidDate(date) || !category || !isFinite(total) || total < 0) {
          throw new Error('missing/invalid required fields');
        }
        insertExpense.run(date, category, description, qty, rate, total, tradeRef, user.id);
      }
      results.inserted++;
    } catch (e) {
      results.skipped++;
      results.errors.push(`Row ${i + 2}: ${e.message}`);
    }
  });

  json(res, 200, results);
}

// ================================================================
// ACCOUNTS + LEDGER (double-entry core)
// Balance for any account = SUM(amount where it's the credit side)
//                          - SUM(amount where it's the debit side)
// Always computed live from ledger_entries — never stored/cached —
// so it can never drift out of sync, same principle as stock.
// ================================================================
const ACCOUNT_CATEGORIES = ['Bank/Cash', 'Party', 'Expense', 'Trade', 'Other'];

function findAccountByName(name) {
  return oneOf('SELECT * FROM accounts WHERE LOWER(name) = LOWER(?)', [String(name).trim()]);
}

function getOrCreateAccount(name, category) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('account name cannot be empty');
  const existing = findAccountByName(trimmed);
  if (existing) return existing;
  const cat = ACCOUNT_CATEGORIES.includes(category) ? category : 'Other';
  const info = run('INSERT INTO accounts (name, category) VALUES (?,?)', [trimmed, cat]);
  return oneOf('SELECT * FROM accounts WHERE id = ?', [info.lastInsertRowid]);
}

function accountBalance(accountId) {
  const credit = oneOf('SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE credit_account_id = ?', [accountId]).v;
  const debit = oneOf('SELECT COALESCE(SUM(amount),0) AS v FROM ledger_entries WHERE debit_account_id = ?', [accountId]).v;
  // Standard double-entry convention: balance = total debits - total credits.
  // Debiting an account increases it (so a bank/cash account goes up when
  // money comes in), crediting decreases it. This is the same rule for
  // every account — asset, expense, party, everything — it's what makes
  // double-entry self-consistent.
  return Math.round((debit - credit) * 100) / 100;
}

function handleListAccounts(req, res) {
  const accounts = rowsOf('SELECT * FROM accounts ORDER BY category, name');
  const withBalance = accounts.map(a => ({ ...a, balance: accountBalance(a.id) }));
  json(res, 200, { accounts: withBalance });
}

async function handleCreateAccount(req, res) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const name = String(body.name || '').trim();
  if (!name) return badRequest(res, 'name is required');
  if (findAccountByName(name)) return badRequest(res, 'an account with this name already exists');
  if (body.category && !ACCOUNT_CATEGORIES.includes(body.category)) return badRequest(res, 'invalid category');
  const account = getOrCreateAccount(name, body.category || 'Other');
  json(res, 201, { account: { ...account, balance: 0 } });
}

function handleListLedger(req, res, query) {
  let sql = `SELECT l.*, c.name AS credit_account, d.name AS debit_account
             FROM ledger_entries l
             JOIN accounts c ON c.id = l.credit_account_id
             JOIN accounts d ON d.id = l.debit_account_id
             WHERE 1=1`;
  const params = [];
  if (query.from) { sql += ' AND l.date >= ?'; params.push(query.from); }
  if (query.to) { sql += ' AND l.date <= ?'; params.push(query.to); }
  if (query.account_id) { sql += ' AND (l.credit_account_id = ? OR l.debit_account_id = ?)'; params.push(query.account_id, query.account_id); }
  sql += ' ORDER BY l.date DESC, l.id DESC';
  json(res, 200, { entries: rowsOf(sql, params) });
}

async function handleCreateLedgerEntry(req, res, user) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const errors = [];
  if (!isValidDate(body.date)) errors.push('date must be YYYY-MM-DD');
  const amount = num(body.amount, NaN);
  if (!isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
  const creditName = String(body.credit_account || '').trim();
  const debitName = String(body.debit_account || '').trim();
  if (!creditName) errors.push('credit_account is required');
  if (!debitName) errors.push('debit_account is required');
  if (creditName && debitName && creditName.toLowerCase() === debitName.toLowerCase()) {
    errors.push('credit_account and debit_account must be different');
  }
  if (errors.length) return badRequest(res, errors.join('; '));

  const creditAccount = getOrCreateAccount(creditName, body.credit_category);
  const debitAccount = getOrCreateAccount(debitName, body.debit_category);

  const info = run(
    `INSERT INTO ledger_entries (date, amount, credit_account_id, debit_account_id, detail, created_by) VALUES (?,?,?,?,?,?)`,
    [body.date, amount, creditAccount.id, debitAccount.id, String(body.detail || '').trim(), user.id]
  );
  const entry = oneOf(
    `SELECT l.*, c.name AS credit_account, d.name AS debit_account
     FROM ledger_entries l JOIN accounts c ON c.id=l.credit_account_id JOIN accounts d ON d.id=l.debit_account_id
     WHERE l.id = ?`, [info.lastInsertRowid]
  );
  json(res, 201, { entry });
}

function handleDeleteLedgerEntry(req, res, id) {
  const existing = oneOf('SELECT * FROM ledger_entries WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('DELETE FROM ledger_entries WHERE id = ?', [id]);
  json(res, 200, { ok: true });
}

function handleCashPosition(req, res) {
  const names = ['Curr. A/c', 'OD A/c', 'Cash'];
  const positions = names.map(name => {
    const acc = findAccountByName(name);
    return { name, balance: acc ? accountBalance(acc.id) : 0 };
  });
  json(res, 200, { positions, total: Math.round(positions.reduce((s, p) => s + p.balance, 0) * 100) / 100 });
}

// ================================================================
// USER MANAGEMENT (admin only)
// ================================================================
function handleListUsers(req, res) {
  json(res, 200, { users: rowsOf('SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC') });
}

async function handleCreateUser(req, res) {
  let body; try { body = await readJson(req); } catch (e) { return badRequest(res, e.message); }
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = body.role === 'admin' ? 'admin' : 'partner';
  if (!name) return badRequest(res, 'name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest(res, 'a valid email is required');
  if (password.length < 8) return badRequest(res, 'password must be at least 8 characters');
  const existing = oneOf('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return badRequest(res, 'a user with this email already exists');
  const info = run('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
    [name, email, hashPassword(password), role]);
  json(res, 201, { user: oneOf('SELECT id, name, email, role, active, created_at FROM users WHERE id = ?', [info.lastInsertRowid]) });
}

function handleDeactivateUser(req, res, id, user) {
  if (String(user.id) === String(id)) return badRequest(res, "You can't deactivate your own account");
  const existing = oneOf('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) return notFound(res);
  run('UPDATE users SET active = 0 WHERE id = ?', [id]);
  run('DELETE FROM sessions WHERE user_id = ?', [id]);
  json(res, 200, { ok: true });
}

// ================================================================
// STATIC FILE SERVING
// ================================================================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) return notFound(res);
        send(res, 200, data2, { 'Content-Type': MIME['.html'] });
      });
      return;
    }
    const ext = path.extname(filePath);
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

// ================================================================
// ROUTER
// ================================================================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    if (!requireSameOrigin(req, res)) return;

    // ---- auth ----
    if (pathname === '/api/auth/login' && req.method === 'POST') return handleLogin(req, res);
    if (pathname === '/api/auth/logout' && req.method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/auth/me' && req.method === 'GET') return handleMe(req, res);

    // everything below requires auth
    const user = requireAuth(req, res);
    if (!user) return;

    if (pathname === '/api/crops' && req.method === 'GET') return handleCrops(req, res);

    if (pathname === '/api/accounts' && req.method === 'GET') return handleListAccounts(req, res);
    if (pathname === '/api/accounts' && req.method === 'POST') return handleCreateAccount(req, res);
    if (pathname === '/api/cash-position' && req.method === 'GET') return handleCashPosition(req, res);
    if (pathname === '/api/ledger' && req.method === 'GET') return handleListLedger(req, res, query);
    if (pathname === '/api/ledger' && req.method === 'POST') return handleCreateLedgerEntry(req, res, user);
    let m;
    if ((m = pathname.match(/^\/api\/ledger\/(\d+)$/)) && req.method === 'DELETE') {
      return requireAdmin(req, res) && handleDeleteLedgerEntry(req, res, m[1]);
    }

    if (pathname === '/api/dashboard' && req.method === 'GET') return handleDashboard(req, res);
    if (pathname === '/api/reports' && req.method === 'GET') return handleReports(req, res, query);
    if (pathname === '/api/stock' && req.method === 'GET') return handleStock(req, res);
    if (pathname === '/api/export' && req.method === 'GET') return handleExport(req, res, query);
    if (pathname === '/api/import' && req.method === 'POST') return handleImport(req, res, user, query);

    if (pathname === '/api/notifications' && req.method === 'GET') return handleListNotifications(req, res);
    if ((m = pathname.match(/^\/api\/notifications\/(\d+)\/read$/)) && req.method === 'POST') return handleMarkNotificationRead(req, res, m[1]);

    if (pathname === '/api/purchases' && req.method === 'GET') return handleListPurchases(req, res, query);
    if (pathname === '/api/purchases' && req.method === 'POST') return handleCreatePurchase(req, res, user);
    if ((m = pathname.match(/^\/api\/purchases\/(\d+)$/))) {
      if (req.method === 'PUT') return handleUpdatePurchase(req, res, m[1]);
      if (req.method === 'DELETE') return requireAdmin(req, res) && handleDeletePurchase(req, res, m[1]);
    }

    if (pathname === '/api/sales' && req.method === 'GET') return handleListSales(req, res, query);
    if (pathname === '/api/sales' && req.method === 'POST') return handleCreateSale(req, res, user);
    if ((m = pathname.match(/^\/api\/sales\/(\d+)$/))) {
      if (req.method === 'PUT') return handleUpdateSale(req, res, m[1]);
      if (req.method === 'DELETE') return requireAdmin(req, res) && handleDeleteSale(req, res, m[1]);
    }

    if (pathname === '/api/expenses' && req.method === 'GET') return handleListExpenses(req, res, query);
    if (pathname === '/api/expenses' && req.method === 'POST') return handleCreateExpense(req, res, user);
    if ((m = pathname.match(/^\/api\/expenses\/(\d+)$/)) && req.method === 'DELETE') {
      return requireAdmin(req, res) && handleDeleteExpense(req, res, m[1]);
    }

    if (pathname === '/api/partners' && req.method === 'GET') return handleListPartners(req, res);
    if (pathname === '/api/partners' && req.method === 'POST') return requireAdmin(req, res) && handleCreatePartner(req, res);
    if ((m = pathname.match(/^\/api\/partners\/(\d+)$/))) {
      if (req.method === 'PUT') return requireAdmin(req, res) && handleUpdatePartner(req, res, m[1]);
      if (req.method === 'DELETE') return requireAdmin(req, res) && handleDeletePartner(req, res, m[1]);
    }

    if (pathname === '/api/users' && req.method === 'GET') return requireAdmin(req, res) && handleListUsers(req, res);
    if (pathname === '/api/users' && req.method === 'POST') return requireAdmin(req, res) && handleCreateUser(req, res);
    if ((m = pathname.match(/^\/api\/users\/(\d+)\/deactivate$/)) && req.method === 'POST') {
      return requireAdmin(req, res) && handleDeactivateUser(req, res, m[1], user);
    }

    return notFound(res);
  } catch (err) {
    serverError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(`Aditya Trading Company server running on http://localhost:${PORT}`);
});

module.exports = server;
