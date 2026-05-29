const { Redis } = require('@upstash/redis');
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

const PREFIX = 'reminder:';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function load() {
  try {
    const keys = await redis.keys(`${PREFIX}*`);
    console.log(`[reminders] ${keys.length} reminder(s) in Redis`);
  } catch (err) {
    console.error('[reminders] Redis load error:', err.message);
  }
}

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

async function fire(r) {
  try {
    const page      = await notion.getPage(r.taskId);
    const status    = notion.getStatus(page);
    const taskName  = notion.getTaskName(page);
    const dueDate   = notion.getDueDate(page);
    const assignees = notion.getAssigneeNames(page);

    // ── Task complete: cancel reminder and send one final notice ──────────────
    if (status === 'Done') {
      await cancel(r.taskId);
      await telegram.sendMessage(`✅ Reminder cancelled — ${taskName} is marked complete`);
      return;
    }

    // ── Task overdue: send an overdue alert instead of a normal reminder ──────
    const today = new Date().toISOString().split('T')[0];
    if (dueDate && dueDate < today) {
      const tags = (assignees?.length ? assignees : ['Unassigned']).map(a => team.tag(a)).join(' ');
      const daysOverdue = Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24));
      await telegram.sendMessage(
        `🚨 *OVERDUE: ${taskName}*\n` +
        `Assigned to: ${tags}\n` +
        `Was due: ${dueDate} (${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} ago)\n` +
        `Status: ${status || 'No status'}\n` +
        `Please update this task in Notion.`
      );
      return;
    }

    // ── Normal reminder ───────────────────────────────────────────────────────
    await telegram.sendMessage(buildMessage({ name: taskName, assignees, dueDate, status, intervalKey: r.intervalKey }));
  } catch (err) {
    console.error('[reminders] fire error:', err.message);
  }
}

async function set(taskId, taskName, intervalKey) {
  if (!INTERVAL_MINUTES[intervalKey]) {
    console.warn(`[reminders] unknown intervalKey: ${intervalKey}`);
    return;
  }
  const existing = await get(taskId);
  await redis.set(`${PREFIX}${taskId}`, {
    taskId,
    taskName,
    intervalKey,
    lastSentAt: existing?.lastSentAt || null,
    createdAt:  existing?.createdAt  || new Date().toISOString(),
  });
  console.log(`[reminders] set ${intervalKey} reminder for "${taskName}"`);
}

async function cancel(taskId) {
  await redis.del(`${PREFIX}${taskId}`);
  console.log(`[reminders] cancelled reminder for ${taskId}`);
}

async function get(taskId) {
  const raw = await redis.get(`${PREFIX}${taskId}`);
  return parse(raw);
}

async function getAll() {
  const keys = await redis.keys(`${PREFIX}*`);
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values
    .map(parse)
    .filter(r => r && INTERVAL_MINUTES[r.intervalKey]);
}

async function checkAndFire() {
  const now = Date.now();
  let all;
  try {
    all = await getAll();
  } catch (err) {
    console.error('[reminders] checkAndFire fetch error:', err.message);
    return;
  }
  for (const r of all) {
    const ms = INTERVAL_MINUTES[r.intervalKey] * 60 * 1000;
    const lastSent = r.lastSentAt ? new Date(r.lastSentAt).getTime() : 0;
    if (now - lastSent >= ms) {
      // Persist updated lastSentAt before firing so restarts don't re-fire
      try {
        await redis.set(`${PREFIX}${r.taskId}`, { ...r, lastSentAt: new Date().toISOString() });
      } catch (err) {
        console.error('[reminders] lastSentAt update error:', err.message);
      }
      await fire(r).catch(console.error);
    }
  }
}

module.exports = { load, set, cancel, get, getAll, checkAndFire, INTERVAL_LABELS, INTERVAL_MINUTES };
