const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');

let store = [];

function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(ARCHIVE_FILE)) {
      store = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[archive] load error:', err.message);
    store = [];
  }
  console.log(`[archive] loaded ${store.length} completed task(s)`);
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('[archive] save error:', err.message);
  }
}

function add(task) {
  store = store.filter(t => t.id !== task.id); // deduplicate
  store.unshift({ ...task, completedAt: task.completedAt || new Date().toISOString() });
  save();
}

function remove(id) {
  const had = store.some(t => t.id === id);
  store = store.filter(t => t.id !== id);
  if (had) save();
}

function getAll() {
  return [...store];
}

module.exports = { load, add, remove, getAll };
