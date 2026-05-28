const cron = require('node-cron');
const notion = require('./notion');
const telegram = require('./telegram');
const tally = require('./tally');
const team = require('./team');
const reminders = require('./reminders');

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

// ── Scheduler setup ─────────────────────────────────────────────────────────

function startScheduler() {
  // Check reminders every 10 minutes
  cron.schedule('*/10 * * * *', () => reminders.checkAndFire().catch(console.error));

  // Daily digest — every day at 9am
  cron.schedule('0 9 * * *', () => sendDailyDigest().catch(console.error));

  // Overdue alert — 6pm every day
  cron.schedule('0 18 * * *', () => sendOverdueAlert().catch(console.error));

  // Weekly report — Monday 9am
  cron.schedule('0 9 * * 1', () => sendWeeklyReport().catch(console.error));

  console.log('[scheduler] Jobs registered: reminders@10min · digest@9am · overdue@6pm · report@Mon9am');
}

module.exports = { startScheduler, sendDailyDigest, sendOverdueAlert, sendWeeklyReport };
