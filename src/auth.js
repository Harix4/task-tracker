const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const redis = require('./redis-client');

const JWT_SECRET  = process.env.JWT_SECRET || 'taskr-dev-secret-change-in-prod';
const JWT_EXPIRES = '30d';

// ── Members ───────────────────────────────────────────────────────────────────
// username must match the Notion "Assigned to" name exactly so task filtering works
const MEMBERS = [
  { username: 'Harihar Singh', displayName: 'Harihar Singh', role: 'admin', telegram: 'harixfour', initials: 'HS' },
  { username: 'Gelika',        displayName: 'Gelika',   role: 'member', telegram: 'Gelika',    initials: 'G'  },
  { username: 'Irakli',        displayName: 'Irakli',   role: 'member', telegram: 'n1tchvar',  initials: 'I'  },
  { username: 'N1ka',          displayName: 'N1ka',     role: 'member', telegram: 'Abduu_19',  initials: 'N'  },
  { username: 'Cole',          displayName: 'Cole',     role: 'member', telegram: 'COLE4L',    initials: 'C'  },
];

const DEFAULT_PINS = {
  'Harihar Singh': '1234',
  'Gelika':        '2345',
  'Irakli':        '3456',
  'N1ka':          '4567',
  'Cole':          '5678',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function pinKey(username) { return `auth:pin:${username}`; }

// ── Setup ─────────────────────────────────────────────────────────────────────

async function isPinsInitialized() {
  const keys = await redis.keys('auth:pin:*');
  return keys.length > 0;
}

async function initDefaultPins() {
  for (const [username, pin] of Object.entries(DEFAULT_PINS)) {
    await redis.set(pinKey(username), hashPin(pin));
  }
  console.log('[auth] default PINs initialised in Redis');
}

// ── PIN operations ────────────────────────────────────────────────────────────

async function verifyPin(username, pin) {
  const stored = await redis.get(pinKey(username));
  if (!stored) return false;
  const hash = typeof stored === 'string' ? stored : String(stored);
  return hash === hashPin(String(pin));
}

async function setPin(username, pin) {
  await redis.set(pinKey(username), hashPin(String(pin)));
}

// ── Timezone ──────────────────────────────────────────────────────────────────

async function saveTimezone(username, tz) {
  if (!tz || typeof tz !== 'string') return;
  await redis.set(`auth:tz:${username}`, tz);
}

async function getTimezone(username) {
  const tz = await redis.get(`auth:tz:${username}`);
  if (tz && typeof tz === 'string') return tz;
  // Fall back to the default tz in team.json rather than UTC
  const team = require('./team');
  return team.getTz(username) || 'UTC';
}

// ── First-time setup flag ─────────────────────────────────────────────────────

async function isSetupComplete(username) {
  const val = await redis.get(`auth:setup:${username}`);
  return !!val;
}

async function markSetupComplete(username) {
  await redis.set(`auth:setup:${username}`, '1');
}

// ── Members ───────────────────────────────────────────────────────────────────

function getMember(username) {
  return MEMBERS.find(m => m.username === username) || null;
}

// ── JWT ───────────────────────────────────────────────────────────────────────

function createToken(username) {
  const m = getMember(username);
  if (!m) return null;
  return jwt.sign(
    { username, role: m.role, telegram: m.telegram, displayName: m.displayName, initials: m.initials },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Express middleware ────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user  = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  req.user = verifyToken(token) || null;
  next();
}

module.exports = {
  MEMBERS, DEFAULT_PINS,
  isPinsInitialized, initDefaultPins,
  verifyPin, setPin,
  saveTimezone, getTimezone,
  isSetupComplete, markSetupComplete,
  getMember, createToken, verifyToken,
  requireAuth, requireAdmin, optionalAuth,
};
