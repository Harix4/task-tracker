const notion = require('./notion');
const telegram = require('./telegram');
const team = require('./team');

const INTERVAL_LABELS = {
  '10min': '10 minutes',
  '30min': '30 minutes',
  '1hr':   '1 hour',
  '2hr':   '2 hours',
  '4hr':   '4 hours',
  '6hr':   '6 hours',
  '8hr':   '8 hours',
};

const INTERVAL_MINUTES = {
  '10min': 10,
  '30min': 30,
  '1hr':   60,
  '2hr':   120,
  '4hr':   240,
  '6hr':   360,
  '8hr':   480,
};

// { taskId → { taskId, taskName, intervalKey, lastSentAt, createdAt } }
const store = {};

// ── Core ─────────────────────────────────────────────────────────────────────

function buildMessage({ name, assignees, dueDate, status, intervalKey }) {
  const tags = (assignees?.length ? assignees : ['Unassigned']).map(a => team.tag(a)).join(' ');
  return (
    `⏰ *Reminder: ${name}*\n` +
    `Assigned to: ${tags}\n` +
    `Due: ${dueDate || 'No due date'}\n` +
    `Status: ${status || 'No status'}\n` +
    `Next reminder in: ${INTERVAL_LABELS[intervalKey] || intervalKey}`
  );
}

async function fire(taskId) {
  const r = store[taskId];
  if (!r) return;
  try {
    const page = await notion.getPage(taskId);
    if (notion.getStatus(page) === 'Done') { cancel(taskId); return; }
    await telegram.sendMessage(buildMessage({
      name:        notion.getTaskName(page),
      assignees:   notion.getAssigneeNames(page),
      dueDate:     notion.getDueDate(page),
      status:      notion.getStatus(page),
      intervalKey: r.intervalKey,
    }));
  } catch (err) {
    console.error('[reminders] fire error:', err.message);
  }
}

function set(taskId, taskName, intervalKey) {
  if (!INTERVAL_MINUTES[intervalKey]) {
    console.warn(`[reminders] unknown intervalKey: ${intervalKey}`);
    return;
  }
  // Preserve createdAt if reminder already existed
  const existing = store[taskId];
  store[taskId] = {
    taskId,
    taskName,
    intervalKey,
    lastSentAt: existing?.lastSentAt || null,
    createdAt:  existing?.createdAt  || new Date().toISOString(),
  };
  console.log(`[reminders] set ${intervalKey} reminder for "${taskName}"`);
}

function cancel(taskId) {
  if (store[taskId]) {
    delete store[taskId];
    console.log(`[reminders] cancelled reminder for ${taskId}`);
  }
}

function getAll() {
  return Object.values(store).map(({ taskId, taskName, intervalKey, lastSentAt, createdAt }) =>
    ({ taskId, taskName, intervalKey, lastSentAt, createdAt })
  );
}

function get(taskId) {
  const r = store[taskId];
  return r ? { taskId: r.taskId, taskName: r.taskName, intervalKey: r.intervalKey, lastSentAt: r.lastSentAt, createdAt: r.createdAt } : null;
}

async function checkAndFire() {
  const now = Date.now();
  for (const r of Object.values(store)) {
    const minutes = INTERVAL_MINUTES[r.intervalKey];
    if (!minutes) continue;
    const ms = minutes * 60 * 1000;
    const lastSent = r.lastSentAt ? new Date(r.lastSentAt).getTime() : 0;
    if (now - lastSent >= ms) {
      r.lastSentAt = new Date().toISOString();
      await fire(r.taskId).catch(console.error);
    }
  }
}

module.exports = { set, cancel, getAll, get, checkAndFire, INTERVAL_LABELS, INTERVAL_MINUTES };
