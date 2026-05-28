let store = [];

function load() {
  // In-memory only — no file I/O on Railway
}

function add(task) {
  store = store.filter(t => t.id !== task.id); // deduplicate
  store.unshift({ ...task, completedAt: task.completedAt || new Date().toISOString() });
}

function remove(id) {
  store = store.filter(t => t.id !== id);
}

function getAll() {
  return [...store];
}

module.exports = { load, add, remove, getAll };
