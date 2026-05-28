// { taskId: { notes, sop, sopLink, resources: [{id, title, content}], assignees: [] } }
let store = {};

function load() {
  // In-memory only — no file I/O on Railway
}

function ensureTask(taskId) {
  if (!store[taskId] || typeof store[taskId] !== 'object') {
    store[taskId] = { notes: '', sop: '', sopLink: '', resources: [], assignees: [] };
  } else if (!store[taskId].assignees) {
    store[taskId].assignees = [];
  }
  return store[taskId];
}

function getAll() { return { ...store }; }

function getTask(taskId) { return store[taskId] || null; }

function updateTask(taskId, fields) {
  const meta = ensureTask(taskId);
  if (fields.notes !== undefined) meta.notes = fields.notes;
  if (fields.sop !== undefined) meta.sop = fields.sop;
  if (fields.sopLink !== undefined) meta.sopLink = fields.sopLink;
  if (fields.resources !== undefined) meta.resources = fields.resources;
  if (fields.assignees !== undefined) meta.assignees = fields.assignees;
  return meta;
}

function genResId() {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

function addResource(taskId, { title, content }) {
  const meta = ensureTask(taskId);
  meta.resources = meta.resources || [];
  const r = { id: genResId(), title: title || '', content: content || '' };
  meta.resources.push(r);
  return r;
}

function updateResource(taskId, resId, fields) {
  const meta = store[taskId];
  if (!meta) return null;
  const r = (meta.resources || []).find(x => x.id === resId);
  if (!r) return null;
  if (fields.title !== undefined) r.title = fields.title;
  if (fields.content !== undefined) r.content = fields.content;
  return r;
}

function deleteResource(taskId, resId) {
  const meta = store[taskId];
  if (!meta) return false;
  const before = (meta.resources || []).length;
  meta.resources = (meta.resources || []).filter(x => x.id !== resId);
  return meta.resources.length < before;
}

module.exports = { load, getAll, getTask, updateTask, addResource, updateResource, deleteResource };
