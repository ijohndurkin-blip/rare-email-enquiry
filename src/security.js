const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

// A per-install secret used to sign session cookies and encrypt stored inbox passwords.
function loadSecret() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const SECRET = loadSecret();

function loadAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const file = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(9).toString('base64url'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

function decrypt(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored || '';
  const buf = Buffer.from(stored.slice(4), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(code), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyCode(code, stored) {
  if (!stored || !code) return false;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(String(code), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- Signed session cookie ------------------------------------------------
const COOKIE = 'ee_session';
const MAX_AGE_MS = 30 * 86400000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function readSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return m ? unsign(decodeURIComponent(m.slice(COOKIE.length + 1))) : null;
}

function writeSession(req, res, session) {
  const token = sign({ ...session, exp: Date.now() + MAX_AGE_MS });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  encrypt, decrypt, hashCode, verifyCode, safeEqual,
  readSession, writeSession, clearSession, loadAdminPassword,
  randomToken: (n = 18) => crypto.randomBytes(n).toString('base64url'),
};
