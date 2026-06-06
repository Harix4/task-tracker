const cron      = require('node-cron');
const notion    = require('./notion');
const telegram  = require('./telegram');
const tally     = require('./tally');
const team      = require('./team');
const reminders = require('./reminders');
const recurring = require('./recurring');
const tasksMeta = require('./tasks-meta');
const redis     = require('./redis-client');

// ── Message builders ────────────────────────────────────────────────────────

function buildDailyDigest(tasks) {
  let msg = '📋 *Tasks due today*\n';

  // Group by sorted assignee combo so shared tasks appear once
  const byGroup = {};
  for (const task of tasks) {
    const key = [...task.assignees].sort().join('|') || 'Unassigned';
    if (!byGroup[key]) byGroup[key] = { assignees: task.assignees.length ? task.assignees : ['Unassigned'], items: [] };
    byGroup[key].items.push(task);
  }

  for (const { assignees, items } of Object.values(byGroup)) {
    const tags = team.tagList(assignees);
    msg += `\n${tags}\n`;
    for (const task of items) {
      const priorityTag = task.priority ? `[${task.priority.replace(/^[^\w]+/, '').toUpperCase()}] ` : '';
      const category = task.category || 'Uncategorized';
      msg += `- ${priorityTag}${task.name} (${category})\n`;
    }
  }

  return msg;
}

function buildOverdueAlert(overdueItems) {
  let msg = '⚠️ *Overdue tasks*\n';

  for (const item of overdueItems) {
    const days = item.daysOverdue;
    const tags = team.tagList(item.assignees);
    msg += `\n${tags} — ${item.name} (${days} day${days !== 1 ? 's' : ''} overdue)`;
  }

  return msg;
}

function buildWeeklyReport(members, topPerformer) {
  const header = 'Member       | Assigned | Done | Missed | Rate';
  const divider = '-------------|----------|------|--------|-----';

  const rows = members.map((m) => {
    const handle = team.tag(m.name).padEnd(12);
    const assigned = String(m.assigned).padStart(8);
    const done = String(m.completed).padStart(4);
    const missed = String(m.missed).padStart(6);
    const rate = `${m.completionRate}%`.padStart(4);
    return `${handle} | ${assigned} | ${done} | ${missed} | ${rate}`;
  });

  const topTag = topPerformer ? team.tag(topPerformer) : null;

  return (
    `📊 *Weekly performance report*\n\n` +
    `\`\`\`\n${header}\n${divider}\n${rows.join('\n')}\n\`\`\`\n\n` +
    (topTag ? `Top performer: *${topTag}* 🏆` : '')
  );
}

// ── Job handlers ────────────────────────────────────────────────────────────

async function sendDailyDigest() {
  console.log('[scheduler] Sending daily digest');
  const today = todayInTz();

  const tasks = await notion.queryTasksDatabase({
    and: [
      { property: 'Due date', date: { equals: today } },
      { property: 'Status', status: { does_not_equal: 'Done' } },
    ],
  });

  if (tasks.length === 0) {
    await telegram.queueNotification('📋 *Tasks due today*\n\nNo tasks due today! ✨');
    return;
  }

  const digestTasks = tasks.map(task => ({
    name:      notion.getTaskName(task),
    priority:  notion.getPriority(task),
    category:  notion.getCategory(task),
    assignees: notion.getAssigneeNames(task),
  }));

  await telegram.queueNotification(buildDailyDigest(digestTasks));
}

async function sendOverdueAlert() {
  console.log('[scheduler] Sending overdue alert');
  const today = todayInTz();

  const tasks = await notion.queryTasksDatabase({
    and: [
      { property: 'Due date', date: { before: today } },
      { property: 'Status', status: { does_not_equal: 'Done' } },
    ],
  });

  if (tasks.length === 0) {
    await telegram.queueNotification('⚠️ *Overdue tasks*\n\nNo overdue tasks! ✅');
    return;
  }

  const overdueItems = tasks.map((task) => {
    const dueDateStr = notion.getDueDate(task);
    const daysOverdue = Math.floor(
      (Date.now() - new Date(dueDateStr).getTime()) / (1000 * 60 * 60 * 24)
    );
    return {
      assignees: notion.getAssigneeNames(task),
      name:      notion.getTaskName(task),
      daysOverdue,
    };
  });

  await telegram.queueNotification(buildOverdueAlert(overdueItems));
}

async function sendWeeklyReport() {
  console.log('[scheduler] Sending weekly performance report');
  let { members, topPerformer } = await tally.computePerformance();
  // Admin never appears in the report
  members = members.filter(m => m.name !== 'Harihar Singh');

  // Fetch stale "To do" tasks (overdue + still not started)
  let staleTasks = [];
  try {
    const today = todayInTz();
    const threeDaysAgo = nDaysAgoInTz(3);
    const all = await notion.queryTasksDatabase({
      and: [
        { property: 'Status', status: { equals: 'To do' } },
        { property: 'Due date', date: { before: threeDaysAgo } },
      ],
    });
    staleTasks = all.map(t => ({
      name:      notion.getTaskName(t),
      assignees: notion.getAssigneeNames(t),
      dueDate:   notion.getDueDate(t),
    }));
  } catch (_) {}

  // Fetch unacknowledged assignments
  let unackLines = [];
  try {
    const keys = await redis.keys('task:assigned:*');
    for (const key of keys) {
      const taskId = key.slice('task:assigned:'.length);
      const raw    = await redis.get(key);
      const info   = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : null);
      if (!info) continue;
      const unacked = [];
      for (const a of (info.assignees || [])) {
        const ack = await redis.get(`task:ack:${taskId}:${a}`).catch(() => '0');
        if (ack !== '1') unacked.push(a);
      }
      if (unacked.length) unackLines.push(`- ${info.taskName}: ${unacked.map(a => team.tag(a)).join(' ')}`);
    }
  } catch (_) {}

  if (members.length === 0) {
    await telegram.queueNotification('📊 *Weekly performance report*\n\nNo performance data available yet.');
    return;
  }

  let msg = buildWeeklyReport(members, topPerformer);

  if (staleTasks.length) {
    msg += `\n\n📋 *Tasks with no updates (3+ days overdue, still To do):*\n` +
      staleTasks.map(t => `- ${t.name} (${team.tagList(t.assignees)}) — due ${t.dueDate || '?'}`).join('\n');
  }

  if (unackLines.length) {
    msg += `\n\n⏳ *Unacknowledged tasks:*\n` + unackLines.join('\n');
  }

  // ── Weekly goals section ──────────────────────────────────────────────────
  try {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const currentWeek = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    const currentKey  = `${d.getFullYear()}-W${String(currentWeek).padStart(2, '0')}`;

    const prev = new Date(d); prev.setDate(prev.getDate() - 7);
    const pjan = new Date(prev.getFullYear(), 0, 1);
    const prevWeek = Math.ceil((((prev - pjan) / 86400000) + pjan.getDay() + 1) / 7);
    const prevKey  = `${prev.getFullYear()}-W${String(prevWeek).padStart(2, '0')}`;

    const [currRaw, prevRaw] = await Promise.all([
      redis.get(`weekly:goals:${currentKey}`),
      redis.get(`weekly:goals:${prevKey}`),
    ]);

    const currGoals = (currRaw && typeof currRaw === 'object' ? currRaw : (currRaw ? JSON.parse(currRaw) : [])) || [];
    const prevGoals = (prevRaw && typeof prevRaw === 'object' ? prevRaw : (prevRaw ? JSON.parse(prevRaw) : [])) || [];

    // Current week's goals
    if (currGoals.length) {
      msg += `\n\n🎯 *This week's goals:*\n` +
        currGoals.map(g => `- ${g.text} (${team.tag(g.owner)})`).join('\n');
    }

    // Last week completion rate
    if (prevGoals.length) {
      const prevDone = prevGoals.filter(g => g.status === 'done').length;
      const pct      = Math.round((prevDone / prevGoals.length) * 100);
      msg += `\n\n📈 *Last week goals: ${prevDone}/${prevGoals.length} completed (${pct}%)${pct === 100 ? ' 🌟' : ''}*`;
    }
  } catch (_) {}

  await telegram.queueNotification(msg);
}

// ── Recurring task generation ────────────────────────────────────────────────

const FREQ_LABELS = {
  daily: 'Daily', weekday: 'Weekday (Mon–Fri)', weekly: 'Weekly',
  biweekly: 'Biweekly', monthly: 'Monthly',
};

async function generateRecurringTasks() {
  console.log('[scheduler] Generating recurring tasks');
  const today = todayInTz();

  // Fetch workspace users once for name→ID mapping
  let workspaceUsers = [];
  try { workspaceUsers = await notion.getWorkspaceUsers(); } catch (_) {}

  const tasks = recurring.getAll().filter(rt => rt.active);
  for (const rt of tasks) {
    if (!recurring.shouldCreateToday(rt, today)) continue;
    try {
      const assigneeIds = (rt.assignees || [])
        .map(name => workspaceUsers.find(u =>
          u.name?.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(u.name?.toLowerCase())
        ))
        .filter(Boolean)
        .map(u => u.id);

      await notion.createTask({
        name: rt.name,
        assigneeIds,
        dueDate: today,
        priority: rt.priority,
        category: rt.category,
      });

      recurring.update(rt.id, { lastCreated: today });

      const tags = team.tagList(rt.assignees);
      const freqLabel = FREQ_LABELS[rt.frequency] || (rt.customDays ? `Every ${rt.customDays} days` : rt.frequency);
      await telegram.queueNotification(
        `🔄 *Recurring task created*\n` +
        `${rt.name}\n` +
        `Assigned to: ${tags}\n` +
        `Due: Today\n` +
        `Frequency: ${freqLabel}`
      );
      console.log(`[scheduler] Created recurring task: "${rt.name}"`);
    } catch (err) {
      console.error(`[scheduler] Failed to generate "${rt.name}":`, err.message);
    }
  }
}

// ── Day-before reminder ──────────────────────────────────────────────────────

async function sendDayBeforeReminders() {
  console.log('[scheduler] Sending day-before reminders');
  const tomorrow = nDaysAgoInTz(-1); // "today + 1" in admin timezone

  const tasks = await notion.queryTasksDatabase({
    and: [
      { property: 'Due date', date: { equals: tomorrow } },
      { property: 'Status', status: { does_not_equal: 'Done' } },
    ],
  });
  if (!tasks.length) return;

  const { personal } = require('./personal');
  const GROUP = process.env.TELEGRAM_CHAT_ID;

  for (const task of tasks) {
    const taskName  = notion.getTaskName(task);
    const dueDate   = notion.getDueDate(task);
    const assignees = notion.getAssigneeNames(task);
    const status    = notion.getStatus(task);
    const tags      = team.tagList(assignees);

    // Fetch notes from in-memory tasks-meta
    const meta      = tasksMeta.getTask(task.id) || {};
    const notes     = meta.notes?.trim() || '';
    const notesLine = notes ? `\n📝 Notes: ${notes.slice(0, 300)}` : '';

    // Group chat notification
    telegram.queueNotification(
      `📅 *Due tomorrow: ${taskName}*\n` +
      `Assigned to: ${tags}\n` +
      `Due: ${dueDate}\n` +
      `Status: ${status || 'No status'}${notesLine}`,
      GROUP
    ).catch(console.error);

    // Personal DM to each assignee (respect dayBefore preference)
    const personalModule = require('./personal');
    for (const assignee of assignees) {
      const member = team.lookup(assignee);
      if (!member) continue;
      // Check pref
      try {
        const raw   = await redis.get(`notif:prefs:${member.name}`);
        const prefs = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : {});
        if (prefs.dayBefore === false) continue;
      } catch (_) {}
      const chatId = await personalModule.getChatId(member.telegram);
      if (!chatId) continue;
      telegram.queueNotification(
        `📅 *Heads up — ${taskName} is due tomorrow.*\n` +
        `Make sure it's done by end of day.${notesLine}`,
        chatId
      ).catch(console.error);
    }
  }
}

// ── Unacknowledged task follow-ups ────────────────────────────────────────────

async function checkUnacknowledgedTasks() {
  const personalModule = require('./personal');
  const now = Date.now();
  const TWO_HOURS  = 2 * 60 * 60 * 1000;
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  try {
    const keys = await redis.keys('task:assigned:*');
    for (const key of keys) {
      const taskId = key.slice('task:assigned:'.length);
      let info;
      try {
        const raw = await redis.get(key);
        info = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(raw) : null);
      } catch (_) { continue; }
      if (!info) continue;

      const elapsed = now - new Date(info.assignedAt).getTime();
      if (elapsed > 24 * 60 * 60 * 1000) continue; // Ignore tasks assigned over 24h ago

      for (const assignee of (info.assignees || [])) {
        const ack = await redis.get(`task:ack:${taskId}:${assignee}`).catch(() => '0');
        if (ack === '1') continue; // already acknowledged

        const member = team.lookup(assignee);
        if (!member) continue;

        // 2-hour follow-up DM (fire once)
        if (elapsed >= TWO_HOURS && elapsed < TWO_HOURS + 35 * 60 * 1000) {
          const sentKey = `task:ack-sent:2h:${taskId}:${assignee}`;
          const alreadySent = await redis.get(sentKey).catch(() => null);
          if (!alreadySent) {
            const chatId = await personalModule.getChatId(member.telegram);
            if (chatId) {
              await telegram.queueNotification(
                `⚠️ *You have an unacknowledged task:*\n` +
                `${info.taskName}\nDue: ${info.dueDate || 'No date'}\n\n` +
                `Reply /accept ${taskId} to confirm you've seen this.`,
                chatId
              ).catch(() => {});
              await redis.set(sentKey, '1');
            }
          }
        }

        // 4-hour admin notification (fire once per task total)
        if (elapsed >= FOUR_HOURS && elapsed < FOUR_HOURS + 35 * 60 * 1000) {
          const adminSentKey = `task:ack-sent:4h:${taskId}:${assignee}`;
          const alreadySent  = await redis.get(adminSentKey).catch(() => null);
          if (!alreadySent) {
            telegram.queueNotification(
              `⚠️ ${team.tag(assignee)} has not acknowledged:\n` +
              `*${info.taskName}*\nDue: ${info.dueDate || 'No date'}\nAssigned 4 hours ago.`,
              process.env.TELEGRAM_CHAT_ID
            ).catch(() => {});
            await redis.set(adminSentKey, '1');
          }
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] checkUnacknowledgedTasks:', err.message);
  }
}

// ── Scheduler setup ─────────────────────────────────────────────────────────

const auth = require('./auth');

// Return today's date string (YYYY-MM-DD) in the given IANA timezone.
// Using the admin's timezone ensures tasks due "today" are never
// flagged overdue until midnight in their local time.
const ADMIN_TZ = 'America/Los_Angeles';
function todayInTz(tz = ADMIN_TZ) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}
function nDaysAgoInTz(n, tz = ADMIN_TZ) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

async function getAdminTz() {
  return ADMIN_TZ; // defined at top of file
}

async function startScheduler() {
  const adminTz = await getAdminTz();
  const tzOpts  = { timezone: adminTz };
  console.log(`[scheduler] Admin timezone: ${adminTz}`);

  // Check reminders every 10 minutes (UTC — interval, not wall clock)
  cron.schedule('*/10 * * * *', () => reminders.checkAndFire().catch(console.error));

  // Generate recurring tasks — 6am in admin's timezone
  cron.schedule('0 6 * * *', () => generateRecurringTasks().catch(console.error), tzOpts);

  // Daily digest — 9am in admin's timezone
  cron.schedule('0 9 * * *', () => sendDailyDigest().catch(console.error), tzOpts);

  // Overdue alert — 6pm in admin's timezone
  cron.schedule('0 18 * * *', () => sendOverdueAlert().catch(console.error), tzOpts);

  // Weekly report — Monday 9am in admin's timezone
  cron.schedule('0 9 * * 1', () => sendWeeklyReport().catch(console.error), tzOpts);

  // Day-before reminder — 8am in admin's timezone
  cron.schedule('0 8 * * *', () => sendDayBeforeReminders().catch(console.error), tzOpts);

  // Check for unacknowledged tasks every 30 minutes (UTC — timing, not wall clock)
  cron.schedule('*/30 * * * *', () => checkUnacknowledgedTasks().catch(console.error));

  console.log(`[scheduler] Jobs registered: recurring@6am · digest@9am · overdue@6pm · report@Mon9am · day-before@8am (all in ${adminTz})`);
}

module.exports = { startScheduler, sendDailyDigest, sendOverdueAlert, sendWeeklyReport, sendDayBeforeReminders };
