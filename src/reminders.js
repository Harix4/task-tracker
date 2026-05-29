const { Redis } = require('@upstash/redis');
const notion   = require('./notion');
const telegram = require('./telegram');
const team     = require('./team');
const personal = require('./personal');

const INTERVAL_LABELS = {
  '10min': '10 minutes', '30min': '30 minutes',
  '1hr':   '1 hour',     '2hr':   '2 hours',
  '4hr':   '4 hours',    '6hr':   '6 hours',
  '8hr':   '8 hours',
};
const INTERVAL_MINUTES = {
  '10min': 10,  '30min': 30,
  '1hr':   60,  '2hr':   120,
  '4hr':   240, '6hr':   360,
  '8hr':   480,
};

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TEAM_PREFIX     = 'reminder:';
const PERSONAL_PREFIX = 'reminder:personal:';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function load() {
  try {
    const [teamKeys, personalKeys] = await Promise.all([
      redis.keys(`${TEAM_PREFIX}*`).then(ks => ks.filter(k => !k.startsWith(PERSONAL_PREFIX))),
      redis.keys(`${PERSONAL_PREFIX}*`),
    ]);
    console.log(`[reminders] ${teamKeys.length} team + ${personalKeys.length} personal reminder(s) in Redis`);
  } catch (err) {
    console.error('[reminders] Redis load error:', err.message);
  }
}

// ── Team reminder message ─────────────────────────────────────────────────────

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

// ── Team reminder fire ────────────────────────────────────────────────────────

async function fireTeam(r) {
  try {
    const page      = await notion.getPage(r.taskId);
    const status    = notion.getStatus(page);
    const taskName  = notion.getTaskName(page);
    const dueDate   = notion.getDueDate(page);
    const assignees = notion.getAssigneeNames(page);

    // Done → cancel + notify
    if (status === 'Done') {
      await cancel(r.taskId);
      await telegram.sendMessage(`✅ Reminder cancelled — ${taskName} is marked complete`);
      return;
    }

    // Overdue → send overdue alert to group
    const today = new Date().toISOString().split('T')[0];
    if (dueDate && dueDate < today) {
      const tags = (assignees?.length ? assignees : ['Unassigned']).map(a => team.tag(a)).join(' ');
      const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
      await telegram.sendMessage(
        `🚨 *OVERDUE: ${taskName}*\n` +
        `Assigned to: ${tags}\n` +
        `Was due: ${dueDate} (${days} day${days !== 1 ? 's' : ''} ago)\n` +
        `Status: ${status || 'No status'}\n` +
        `Please update this task in Notion.`
      );
      return;
    }

    // Normal reminder to group
    await telegram.sendMessage(buildMessage({ name: taskName, assignees, dueDate, status, intervalKey: r.intervalKey }));
  } catch (err) {
    console.error('[reminders] fireTeam error:', err.message);
  }
}

// ── Team reminder CRUD ────────────────────────────────────────────────────────

async function set(taskId, taskName, intervalKey) {
  if (!INTERVAL_MINUTES[intervalKey]) {
    console.warn(`[reminders] unknown intervalKey: ${intervalKey}`);
    return;
  }
  const existing = await get(taskId);
  await redis.set(`${TEAM_PREFIX}${taskId}`, {
    taskId, taskName, intervalKey,
    lastSentAt: existing?.lastSentAt || null,
    createdAt:  existing?.createdAt  || new Date().toISOString(),
  });
  console.log(`[reminders] set ${intervalKey} team reminder for "${taskName}"`);
}

async function cancel(taskId) {
  await redis.del(`${TEAM_PREFIX}${taskId}`);
}

async function get(taskId) {
  return parse(await redis.get(`${TEAM_PREFIX}${taskId}`));
}

async function getAll() {
  const keys = await redis.keys(`${TEAM_PREFIX}*`);
  const teamKeys = keys.filter(k => !k.startsWith(PERSONAL_PREFIX));
  if (!teamKeys.length) return [];
  const values = await redis.mget(...teamKeys);
  return values.map(parse).filter(r => r && INTERVAL_MINUTES[r.intervalKey]);
}

// ── Personal reminder fire ────────────────────────────────────────────────────

async function firePersonal(r) {
  try {
    // Resolve DM chat ID — NEVER fall back to group chat
    const chatId = await personal.getChatId(r.telegramUsername);
    if (!chatId) {
      console.warn(`[reminders] No personal chat ID for ${r.username} (@${r.telegramUsername}) — skipping`);
      return;
    }

    const task = await personal.getTask(r.username, r.taskId);

    if (!task || task.status === 'done') {
      await cancelPersonal(r.username, r.taskId);
      if (task) {
        await telegram.sendMessage(
          `✅ Personal reminder cancelled — "${r.taskName}" is complete`,
          chatId
        );
      }
      return;
    }

    const today = new Date().toISOString().split('T')[0];

    if (task.dueDate && task.dueDate < today) {
      const days = Math.floor((Date.now() - new Date(task.dueDate).getTime()) / 86400000);
      await telegram.sendMessage(
        `🚨 *OVERDUE (Personal): ${task.name}*\n` +
        `Was due: ${task.dueDate} (${days} day${days !== 1 ? 's' : ''} ago)\n` +
        `Please complete this task.`,
        chatId
      );
    } else {
      await telegram.sendMessage(
        `⏰ *Personal Reminder: ${task.name}*\n` +
        `Due: ${task.dueDate || 'No due date'}\n` +
        `Priority: ${task.priority || 'Not set'}\n` +
        `Reminding every: ${INTERVAL_LABELS[r.intervalKey] || r.intervalKey}`,
        chatId
      );
    }
  } catch (err) {
    console.error('[reminders] firePersonal error:', err.message);
  }
}

// ── Personal reminder CRUD ────────────────────────────────────────────────────

async function setPersonal(username, taskId, taskName, intervalKey, telegramUsername) {
  if (!INTERVAL_MINUTES[intervalKey]) return;
  const key      = `${PERSONAL_PREFIX}${username}:${taskId}`;
  const existing = parse(await redis.get(key));
  await redis.set(key, {
    username, taskId, taskName, intervalKey, telegramUsername,
    lastSentAt: existing?.lastSentAt || null,
    createdAt:  existing?.createdAt  || new Date().toISOString(),
  });
  console.log(`[reminders] set ${intervalKey} personal reminder for "${taskName}" (${username})`);
}

async function cancelPersonal(username, taskId) {
  await redis.del(`${PERSONAL_PREFIX}${username}:${taskId}`);
}

async function getPersonal(username, taskId) {
  return parse(await redis.get(`${PERSONAL_PREFIX}${username}:${taskId}`));
}

async function getAllPersonal() {
  const keys = await redis.keys(`${PERSONAL_PREFIX}*`);
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values.map(parse).filter(r => r && INTERVAL_MINUTES[r.intervalKey]);
}

// ── Main cron tick ────────────────────────────────────────────────────────────

async function checkAndFire() {
  const now = Date.now();

  // ── Team reminders ────────────────────────────────────────────────────────
  let teamAll;
  try { teamAll = await getAll(); }
  catch (err) { console.error('[reminders] checkAndFire team fetch:', err.message); teamAll = []; }

  for (const r of teamAll) {
    const ms       = INTERVAL_MINUTES[r.intervalKey] * 60 * 1000;
    const lastSent = r.lastSentAt ? new Date(r.lastSentAt).getTime() : 0;
    if (now - lastSent >= ms) {
      try { await redis.set(`${TEAM_PREFIX}${r.taskId}`, { ...r, lastSentAt: new Date().toISOString() }); } catch {}
      await fireTeam(r).catch(console.error);
    }
  }

  // ── Personal reminders ────────────────────────────────────────────────────
  let personalAll;
  try { personalAll = await getAllPersonal(); }
  catch (err) { console.error('[reminders] checkAndFire personal fetch:', err.message); personalAll = []; }

  for (const r of personalAll) {
    const ms       = INTERVAL_MINUTES[r.intervalKey] * 60 * 1000;
    const lastSent = r.lastSentAt ? new Date(r.lastSentAt).getTime() : 0;
    if (now - lastSent >= ms) {
      try { await redis.set(`${PERSONAL_PREFIX}${r.username}:${r.taskId}`, { ...r, lastSentAt: new Date().toISOString() }); } catch {}
      await firePersonal(r).catch(console.error);
    }
  }
}

module.exports = {
  load, set, cancel, get, getAll,
  setPersonal, cancelPersonal, getPersonal,
  checkAndFire, INTERVAL_LABELS, INTERVAL_MINUTES,
};
