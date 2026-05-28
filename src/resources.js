const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'resources.json');

let store = [];

function genId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[resources] load error:', err.message);
    store = [];
  }
  console.log(`[resources] loaded ${store.length} resource(s)`);
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('[resources] save error:', err.message);
  }
}

function getAll() { return [...store]; }

function get(id) { return store.find(r => r.id === id) || null; }

function create({ title, content, category }) {
  const now = new Date().toISOString();
  const resource = { id: genId(), title: title || 'Untitled', content: content || '', category: category || '', createdAt: now, updatedAt: now };
  store.unshift(resource);
  save();
  return resource;
}

function update(id, fields) {
  const r = store.find(r => r.id === id);
  if (!r) return null;
  if (fields.title !== undefined) r.title = fields.title;
  if (fields.content !== undefined) r.content = fields.content;
  if (fields.category !== undefined) r.category = fields.category;
  r.updatedAt = new Date().toISOString();
  save();
  return r;
}

function remove(id) {
  const had = store.some(r => r.id === id);
  store = store.filter(r => r.id !== id);
  if (had) save();
  return had;
}

module.exports = { load, getAll, get, create, update, remove };
