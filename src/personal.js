const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TASKS_PREFIX = 'personal:tasks:';
const CHAT_PREFIX  = 'personal:chatid:';

function genId() {
  return `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function parse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
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
  const task = {
    id:               genId(),
    name:             fields.name || '',
    dueDate:          fields.dueDate          || null,
    priority:         fields.priority         || null,
    notes:            fields.notes            || '',
    reminderInterval: fields.reminderInterval || null,
    status:           'active',
    createdAt:        new Date().toISOString(),
  };
  tasks.unshift(task);
  await redis.set(`${TASKS_PREFIX}${username}`, tasks);
  return task;
}

async function updateTask(username, taskId, fields) {
  const tasks = await getTasks(username);
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  Object.assign(tasks[idx], fields);
  await redis.set(`${TASKS_PREFIX}${username}`, tasks);
  return tasks[idx];
}

async function deleteTask(username, taskId) {
  const tasks  = await getTasks(username);
  const before = tasks.length;
  const filtered = tasks.filter(t => t.id !== taskId);
  if (filtered.length === before) return false;
  await redis.set(`${TASKS_PREFIX}${username}`, filtered);
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

module.exports = { getTasks, getTask, addTask, updateTask, deleteTask, getChatId, setChatId };
