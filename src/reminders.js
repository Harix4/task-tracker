const redis    = require('./redis-client');
const notion   = require('./notion');
const telegram = require('./telegram');
const team     = require('./team');
const personal = require('./personal');
const auth     = require('./auth');

// Check a user's notification preference (defaults to true / on)
async function notifPref(username, type) {
  try {
    const raw   = await redis.get(`notif:prefs:${username}`);
    const prefs = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : {});
    return prefs[type] !== false;
  } catch { return true; }
}

// Format current time in a given IANA timezone, e.g. "9:05 AM"
function localTimeStr(tz) {
  try {
    return new Date().toLocaleTimeString('en-US', {
      timeZone: tz || 'UTC', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return ''; }
}

// Format a YYYY-MM-DD date string in a given timezone
function fmtDueDate(dateStr, tz) {
  if (!dateStr) return 'No due date';
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
      timeZone: tz || 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return dateStr; }
}

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

const TEAM_PREFIX     = 'reminder:';
const PERSONAL_PREFIX = 'reminder:personal:';

// ── Notification routing contract ─────────────────────────────────────────────
// TEAM tasks   → always TELEGRAM_CHAT_ID (group chat). No exceptions.
// PERSONAL tasks → always personal:chatid:{telegramUsername} DM.
//                  If the key is not in Redis → log warning, send nothing.
//                  NEVER fall back to group chat for personal tasks.

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
  const tags = team.tagList(assignees);
  return (
    `⏰ *Reminder: ${name}*\n` +
    `Assigned to: ${tags}\n` +
    `Due: ${dueDate || 'No due date'}\n` +
    `Status: ${status || 'No status'}\n` +
    `Next reminder in: ${INTERVAL_LABELS[intervalKey] || intervalKey}`
  );
}

// ── Team reminder fire → GROUP CHAT ONLY ─────────────────────────────────────

async function fireTeam(r) {
  const GROUP = process.env.TELEGRAM_CHAT_ID; // always group, never personal
  try {
    const page      = await notion.getPage(r.taskId);
    const status    = notion.getStatus(page);
    const taskName  = notion.getTaskName(page);
    const dueDate   = notion.getDueDate(page);
    const assignees = notion.getAssigneeNames(page);

    // Done → cancel + notify group
    if (status === 'Done') {
      await cancel(r.taskId);
      await telegram.queueNotification(`✅ Reminder cancelled — ${taskName} is marked complete`, GROUP);
      return;
    }

    // Overdue → overdue alert to group
    const today = new Date().toISOString().split('T')[0];
    if (dueDate && dueDate < today) {
      const tags = team.tagList(assignees);
      const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
      await telegram.queueNotification(
        `🚨 *OVERDUE: ${taskName}*\n` +
        `Assigned to: ${tags}\n` +
        `Was due: ${dueDate} (${days} day${days !== 1 ? 's' : ''} ago)\n` +
        `Status: ${status || 'No status'}\n` +
        `Please update this task in Notion.`,
        GROUP
      );
      return;
    }

    // Normal reminder to group — include local time for each assignee's timezone
    const tzLines = [];
    for (const name of (assignees || [])) {
      const tz = await auth.getTimezone(name).catch(() => null);
      if (tz && tz !== 'UTC') tzLines.push(`${name}: ${localTimeStr(tz)}`);
    }
    const tzNote = tzLines.length ? `\nLocal times: ${tzLines.join(' · ')}` : '';
    await telegram.queueNotification(
      buildMessage({ name: taskName, assignees, dueDate, status, intervalKey: r.intervalKey }) + tzNote,
      GROUP
    );
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
    // ── Debug logging ───────────────────────────────────────────────────────
    console.log('[personal-reminder] Firing for:', r.username);
    console.log('[personal-reminder] Looking up chatId for telegram username:', r.telegramUsername);
    console.log('[personal-reminder] Redis key:', `personal:chatid:${(r.telegramUsername || '').toLowerCase()}`);

    // Resolve DM chat ID — NEVER fall back to group chat
    const chatId = await personal.getChatId(r.telegramUsername);
    console.log('[personal-reminder] chatId found:', chatId ? `${chatId.slice(0, 4)}…` : 'NONE');

    if (!chatId) {
      console.warn(`[reminders] No personal chat ID for ${r.username} (@${r.telegramUsername}) — skipping`);
      return;
    }

    const task = await personal.getTask(r.username, r.taskId);

    if (!task || task.status === 'done') {
      await cancelPersonal(r.username, r.taskId);
      if (task) {
        await telegram.queueNotification(
          `✅ Personal reminder cancelled — "${r.taskName}" is complete`,
          chatId
        );
      }
      return;
    }

    const tz    = await auth.getTimezone(r.username);
    const today = new Date().toISOString().split('T')[0];

    // Strip emoji prefix from priority value (e.g. "🔴 High" → "High")
    const priorityLabel = task.priority
      ? task.priority.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}️‍\s]+/u, '').trim()
      : 'Not set';

    // Build message for a given recipient timezone
    function buildMsg(recipientTz) {
      const tStr = localTimeStr(recipientTz);
      if (task.dueDate && task.dueDate < today) {
        const days = Math.floor((Date.now() - new Date(task.dueDate + 'T12:00:00').getTime()) / 86400000);
        return (
          `🚨 *OVERDUE (Personal): ${task.name}*\n` +
          `Was due: ${fmtDueDate(task.dueDate, recipientTz)} (${days} day${days !== 1 ? 's' : ''} ago)\n` +
          `Your time: ${tStr}\n` +
          `Please complete this task.`
        );
      }
      return (
        `⏰ *Personal Reminder: ${task.name}*\n` +
        `Due: ${fmtDueDate(task.dueDate, recipientTz)}\n` +
        `Priority: ${priorityLabel}\n` +
        `Your time: ${tStr}\n` +
        `Reminding every: ${INTERVAL_LABELS[r.intervalKey] || r.intervalKey}`
      );
    }

    // Send to task owner (respect their notification preferences)
    const prefType = (task.dueDate && task.dueDate < today) ? 'overdue' : 'dayBefore';
    if (await notifPref(r.username, prefType)) {
      await telegram.queueNotification(buildMsg(tz), chatId);
    }

    // Send to collaborators (respect their notification preferences)
    for (const collab of (task.collaborators || [])) {
      const collabMember = team.lookup(collab);
      if (!collabMember) continue;
      if (!(await notifPref(collab, prefType))) continue;
      const collabChatId = await personal.getChatId(collabMember.telegram);
      if (!collabChatId) continue;
      const collabTz = await auth.getTimezone(collab);
      await telegram.queueNotification(buildMsg(collabTz), collabChatId).catch(err =>
        console.warn('[reminders] collab DM error:', err.message)
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
