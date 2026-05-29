const redis = require('./redis-client');

const TASKS_PREFIX  = 'personal:tasks:';
const CHAT_PREFIX   = 'personal:chatid:';
const COLLAB_PREFIX = 'personal:collab:'; // index of tasks shared WITH a user

function genId() {
  return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function parse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Collaboration index ───────────────────────────────────────────────────────
// personal:collab:{username} = [{ creatorUsername, taskId }, ...]

async function addCollabEntry(collabUsername, creatorUsername, taskId) {
  const raw     = await redis.get(`${COLLAB_PREFIX}${collabUsername}`);
  const entries = parse(raw) || [];
  if (!entries.find(e => e.taskId === taskId && e.creatorUsername === creatorUsername)) {
    entries.push({ creatorUsername, taskId });
    await redis.set(`${COLLAB_PREFIX}${collabUsername}`, entries);
  }
}

async function removeCollabEntry(collabUsername, taskId) {
  const raw     = await redis.get(`${COLLAB_PREFIX}${collabUsername}`);
  const entries = (parse(raw) || []).filter(e => e.taskId !== taskId);
  await redis.set(`${COLLAB_PREFIX}${collabUsername}`, entries);
}

// Return tasks shared WITH this user (they are a collaborator, not the creator)
async function getCollabTasks(username) {
  const raw     = await redis.get(`${COLLAB_PREFIX}${username}`);
  const entries = parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const tasks = [];
  for (const { creatorUsername, taskId } of entries) {
    try {
      const task = await getTask(creatorUsername, taskId);
      if (task) tasks.push({ ...task, _isCollab: true, _creatorUsername: creatorUsername });
    } catch (err) {
      console.warn('[personal] collab task fetch error:', err.message);
    }
  }
  return tasks;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

async function getTasks(username) {
  const raw = await redis.get(`${TASKS_PREFIX}${username}`);
  const arr = parse(raw);
  return Array.isArray(arr) ? arr : [];
}

async function getTask(username, taskId) {
  const tasks = await getTasks(username);
  return tasks.find(t => t.id === taskId) || null;
}

async function addTask(username, fields) {
  const tasks = await getTasks(username);
  // Ensure creator is not in their own collaborators list
  const collaborators = (Array.isArray(fields.collaborators) ? fields.collaborators : [])
    .filter(c => c !== username);

  const task = {
    id:               genId(),
    name:             fields.name             || '',
    dueDate:          fields.dueDate          || null,
    priority:         fields.priority         || null,
    notes:            fields.notes            || '',
    reminderInterval: fields.reminderInterval || null,
    collaborators,
    createdBy:        username,
    status:           'active',
    createdAt:        new Date().toISOString(),
  };
  tasks.unshift(task);
  await redis.set(`${TASKS_PREFIX}${username}`, tasks);

  // Register collab index entries
  for (const collab of collaborators) {
    await addCollabEntry(collab, username, task.id);
  }
  return task;
}

async function updateTask(username, taskId, fields) {
  const tasks = await getTasks(username);
  const idx   = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;

  const oldCollabs = tasks[idx].collaborators || [];
  const newCollabs = Array.isArray(fields.collaborators) ? fields.collaborators.filter(c => c !== username) : oldCollabs;

  Object.assign(tasks[idx], { ...fields, collaborators: newCollabs });
  await redis.set(`${TASKS_PREFIX}${username}`, tasks);

  // Keep collab index in sync
  const added   = newCollabs.filter(c => !oldCollabs.includes(c));
  const removed = oldCollabs.filter(c => !newCollabs.includes(c));
  for (const c of added)   await addCollabEntry(c, username, taskId);
  for (const c of removed) await removeCollabEntry(c, taskId);

  return tasks[idx];
}

async function deleteTask(username, taskId) {
  const tasks   = await getTasks(username);
  const task    = tasks.find(t => t.id === taskId);
  const before  = tasks.length;
  const filtered = tasks.filter(t => t.id !== taskId);
  if (filtered.length === before) return false;

  await redis.set(`${TASKS_PREFIX}${username}`, filtered);

  // Clean up collab index entries
  for (const collab of (task?.collaborators || [])) {
    await removeCollabEntry(collab, taskId);
  }
  return true;
}

// ── Telegram DM registration ──────────────────────────────────────────────────

async function getChatId(telegramUsername) {
  const v = await redis.get(`${CHAT_PREFIX}${telegramUsername}`);
  return v ? String(v) : null;
}

async function setChatId(telegramUsername, chatId) {
  await redis.set(`${CHAT_PREFIX}${telegramUsername}`, String(chatId));
}

module.exports = {
  getTasks, getTask, addTask, updateTask, deleteTask,
  getCollabTasks, addCollabEntry, removeCollabEntry,
  getChatId, setChatId,
};
