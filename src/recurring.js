let store = [];

function genId() {
  return `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

function load() {
  // In-memory only — no file I/O on Railway
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
  return rec;
}

function update(id, fields) {
  const idx = store.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(store[idx], fields);
  return store[idx];
}

function remove(id) {
  const before = store.length;
  store = store.filter(r => r.id !== id);
  return store.length < before;
}

function togglePause(id) {
  const rec = store.find(r => r.id === id);
  if (!rec) return null;
  rec.active = !rec.active;
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
