const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'recurring.json');

let store = [];

function genId() {
  return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (Array.isArray(raw)) store = raw;
    }
  } catch (err) {
    console.error('[recurring] load error:', err.message);
    store = [];
  }
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('[recurring] save error:', err.message);
  }
}

function getAll() { return store; }

function getById(id) { return store.find(r => r.id === id) || null; }

function create(fields) {
  const rec = {
    id: genId(),
    name:             fields.name || '',
    assignees:        fields.assignees || [],
    category:         fields.category || '',
    priority:         fields.priority || '',
    frequency:        fields.frequency || 'daily',
    dayOfWeek:        fields.dayOfWeek   ?? null,   // 0-6 (Sun-Sat)
    dayOfMonth:       fields.dayOfMonth  ?? null,   // 1-31
    customDays:       fields.customDays  ?? null,
    startDate:        fields.startDate   || new Date().toISOString().split('T')[0],
    lastCreated:      null,
    reminderInterval: fields.reminderInterval || null,
    notes:            fields.notes || '',
    sop:              fields.sop   || '',
    active:           true,
  };
  store.push(rec);
  save();
  return rec;
}

function update(id, fields) {
  const idx = store.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(store[idx], fields);
  save();
  return store[idx];
}

function remove(id) {
  const before = store.length;
  store = store.filter(r => r.id !== id);
  if (store.length < before) { save(); return true; }
  return false;
}

function togglePause(id) {
  const rec = store.find(r => r.id === id);
  if (!rec) return null;
  rec.active = !rec.active;
  save();
  return rec;
}

// Determine if a recurring task should generate a new Notion task today
function shouldCreateToday(rt, today) {
  if (!rt.active) return false;
  if (today < rt.startDate) return false;
  if (rt.lastCreated === today) return false;   // already created today

  const todayDate = new Date(today);
  const dow = todayDate.getDay();   // 0=Sun … 6=Sat
  const dom = todayDate.getDate();  // 1-31

  switch (rt.frequency) {
    case 'daily':
      return true;
    case 'weekday':
      return dow >= 1 && dow <= 5;
    case 'weekly':
      return rt.dayOfWeek === dow;
    case 'biweekly': {
      const last = new Date(rt.lastCreated || rt.startDate);
      return Math.floor((todayDate - last) / 86400000) >= 14;
    }
    case 'monthly':
      return rt.dayOfMonth === dom;
    case 'custom': {
      const last = new Date(rt.lastCreated || rt.startDate);
      return Math.floor((todayDate - last) / 86400000) >= (rt.customDays || 1);
    }
    default:
      return false;
  }
}

module.exports = { load, getAll, getById, create, update, remove, togglePause, shouldCreateToday };
