const notion = require('./notion');

async function computePerformance() {
  const tasks = await notion.queryTasksDatabase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const counts = {};

  for (const task of tasks) {
    const assignee = notion.getAssigneeName(task);
    if (!assignee) continue;

    if (!counts[assignee]) {
      counts[assignee] = { assigned: 0, completed: 0, missed: 0 };
    }

    counts[assignee].assigned++;

    const status = notion.getStatus(task);
    const dueDateStr = notion.getDueDate(task);

    if (status === 'Done') {
      counts[assignee].completed++;
    } else if (dueDateStr) {
      const dueDate = new Date(dueDateStr + 'T00:00:00');
      if (dueDate < today) {
        counts[assignee].missed++;
      }
    }
  }

  const members = Object.entries(counts)
    .map(([name, data]) => ({
      name,
      assigned: data.assigned,
      completed: data.completed,
      missed: data.missed,
      completionRate: data.assigned > 0 ? Math.round((data.completed / data.assigned) * 100) : 0,
    }))
    .sort((a, b) => b.completionRate - a.completionRate);

  return {
    members,
    topPerformer: members.length > 0 ? members[0].name : null,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { computePerformance };
