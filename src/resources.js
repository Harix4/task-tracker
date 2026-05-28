let store = [];

function genId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function load() {
  // In-memory only — no file I/O on Railway
}

function getAll() { return [...store]; }

function get(id) { return store.find(r => r.id === id) || null; }

function create({ title, content, category }) {
  const now = new Date().toISOString();
  const resource = { id: genId(), title: title || 'Untitled', content: content || '', category: category || '', createdAt: now, updatedAt: now };
  store.unshift(resource);
  return resource;
}

function update(id, fields) {
  const r = store.find(r => r.id === id);
  if (!r) return null;
  if (fields.title !== undefined) r.title = fields.title;
  if (fields.content !== undefined) r.content = fields.content;
  if (fields.category !== undefined) r.category = fields.category;
  r.updatedAt = new Date().toISOString();
  return r;
}

function remove(id) {
  const had = store.some(r => r.id === id);
  store = store.filter(r => r.id !== id);
  return had;
}

module.exports = { load, getAll, get, create, update, remove };
