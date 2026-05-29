const cron = require('node-cron');
const notion = require('./notion');
const telegram = require('./telegram');
const tally = require('./tally');
const team = require('./team');
const reminders = require('./reminders');
const recurring = require('./recurring');

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
    const tags = assignees.map(a => team.tag(a)).join(' ');
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
    const tags = (item.assignees.length ? item.assignees : ['Unassigned']).map(a => team.tag(a)).join(' ');
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
  const today = new Date().toISOString().split('T')[0];

  const tasks = await notion.queryTasksDatabase({
    and: [
      { property: 'Due date', date: { equals: today } },
      { property: 'Status', status: { does_not_equal: 'Done' } },
    ],
  });

  if (tasks.length === 0) {
    await telegram.sendMessage('📋 *Tasks due today*\n\nNo tasks due today! ✨');
    return;
  }

  const digestTasks = tasks.map(task => ({
    name:      notion.getTaskName(task),
    priority:  notion.getPriority(task),
    category:  notion.getCategory(task),
    assignees: notion.getAssigneeNames(task),
  }));

  await telegram.sendMessage(buildDailyDigest(digestTasks));
}

async function sendOverdueAlert() {
  console.log('[scheduler] Sending overdue alert');
  const today = new Date().toISOString().split('T')[0];

  const tasks = await notion.queryTasksDatabase({
    and: [
      { property: 'Due date', date: { before: today } },
      { property: 'Status', status: { does_not_equal: 'Done' } },
    ],
  });

  if (tasks.length === 0) {
    await telegram.sendMessage('⚠️ *Overdue tasks*\n\nNo overdue tasks! ✅');
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

  await telegram.sendMessage(buildOverdueAlert(overdueItems));
}

async function sendWeeklyReport() {
  console.log('[scheduler] Sending weekly performance report');
  const { members, topPerformer } = await tally.computePerformance();

  if (members.length === 0) {
    await telegram.sendMessage('📊 *Weekly performance report*\n\nNo performance data available yet.');
    return;
  }

  await telegram.sendMessage(buildWeeklyReport(members, topPerformer));
}

// ── Recurring task generation ────────────────────────────────────────────────

const FREQ_LABELS = {
  daily: 'Daily', weekday: 'Weekday (Mon–Fri)', weekly: 'Weekly',
  biweekly: 'Biweekly', monthly: 'Monthly',
};

async function generateRecurringTasks() {
  console.log('[scheduler] Generating recurring tasks');
  const today = new Date().toISOString().split('T')[0];

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

      const tags = (rt.assignees || []).map(n => team.tag(n)).join(' ') || 'Unassigned';
      const freqLabel = FREQ_LABELS[rt.frequency] || (rt.customDays ? `Every ${rt.customDays} days` : rt.frequency);
      await telegram.sendMessage(
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
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tomorrow = d.toISOString().split('T')[0];

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
    const tags      = assignees.length ? assignees.map(n => team.tag(n)).join(' ') : 'Unassigned';

    // Group chat notification
    telegram.sendMessage(
      `📅 *Due tomorrow: ${taskName}*\n` +
      `Assigned to: ${tags}\n` +
      `Due: ${dueDate}\n` +
      `Status: ${status || 'No status'}`,
      GROUP
    ).catch(console.error);

    // Personal DM to each assignee
    for (const assignee of assignees) {
      const member = team.lookup(assignee);
      if (!member) continue;
      const chatId = await require('./personal').getChatId(member.telegram);
      if (!chatId) continue;
      telegram.sendMessage(
        `📅 *Heads up — ${taskName} is due tomorrow.*\n` +
        `Make sure it's done by end of day.`,
        chatId
      ).catch(console.error);
    }
  }
}

// ── Scheduler setup ─────────────────────────────────────────────────────────

const auth = require('./auth');

async function getAdminTz() {
  // Admin is Harihar Singh; fall back to UTC if not set
  try { return await auth.getTimezone('Harihar Singh'); }
  catch { return 'UTC'; }
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

  console.log(`[scheduler] Jobs registered: recurring@6am · digest@9am · overdue@6pm · report@Mon9am · day-before@8am (all in ${adminTz})`);
}

module.exports = { startScheduler, sendDailyDigest, sendOverdueAlert, sendWeeklyReport };
