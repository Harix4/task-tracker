const cron = require('node-cron');
const notion = require('./notion');
const telegram = require('./telegram');
const tally = require('./tally');

// ── Message builders ────────────────────────────────────────────────────────

function buildDailyDigest(byAssignee) {
  let msg = '📋 *Tasks due today*\n';

  for (const [assignee, tasks] of Object.entries(byAssignee)) {
    msg += `\n@${assignee}\n`;
    for (const task of tasks) {
      const priorityTag = task.priority ? `[${task.priority.toUpperCase()}] ` : '';
      const category = task.category || 'Uncategorized';
      const sopStr = task.sop ? `— SOP: ${task.sop}` : '— _(no SOP — add one)_';
      msg += `- ${priorityTag}${task.name} (${category}) ${sopStr}\n`;
    }
  }

  return msg;
}

function buildOverdueAlert(overdueItems) {
  let msg = '⚠️ *Overdue tasks*\n';

  for (const item of overdueItems) {
    const days = item.daysOverdue;
    msg += `\n@${item.assignee} — ${item.name} (${days} day${days !== 1 ? 's' : ''} overdue)`;
  }

  return msg;
}

function buildWeeklyReport(members, topPerformer) {
  const header = 'Member     | Assigned | Done | Missed | Rate';
  const divider = '-----------|----------|------|--------|-----';

  const rows = members.map((m) => {
    const name = m.name.slice(0, 10).padEnd(10);
    const assigned = String(m.assigned).padStart(8);
    const done = String(m.completed).padStart(4);
    const missed = String(m.missed).padStart(6);
    const rate = `${m.completionRate}%`.padStart(4);
    return `${name} | ${assigned} | ${done} | ${missed} | ${rate}`;
  });

  return (
    `📊 *Weekly performance report*\n\n` +
    `\`\`\`\n${header}\n${divider}\n${rows.join('\n')}\n\`\`\`\n\n` +
    (topPerformer ? `Top performer: *${topPerformer}*` : '')
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

  const byAssignee = {};
  for (const task of tasks) {
    const assignee = notion.getAssigneeName(task) || 'Unassigned';
    if (!byAssignee[assignee]) byAssignee[assignee] = [];
    byAssignee[assignee].push({
      name: notion.getTaskName(task),
      priority: notion.getPriority(task),
      category: notion.getCategory(task),
      sop: notion.getSOP(task),
    });
  }

  await telegram.sendMessage(buildDailyDigest(byAssignee));
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
      assignee: notion.getAssigneeName(task) || 'Unassigned',
      name: notion.getTaskName(task),
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
  // Daily digest — every 2 hours
  cron.schedule('0 */2 * * *', () => sendDailyDigest().catch(console.error));

  // Overdue alert — 6pm every day
  cron.schedule('0 18 * * *', () => sendOverdueAlert().catch(console.error));

  // Weekly report — Monday 9am
  cron.schedule('0 9 * * 1', () => sendWeeklyReport().catch(console.error));

  console.log('[scheduler] Jobs registered: digest@9am · overdue@6pm · report@Mon9am');
}

module.exports = { startScheduler, sendDailyDigest, sendOverdueAlert, sendWeeklyReport };
