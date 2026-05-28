require('dotenv').config();

const express = require('express');
const path = require('path');
const { handleWebhook } = require('./webhook');
const { startScheduler } = require('./scheduler');
const { computePerformance } = require('./tally');
const notion = require('./notion');
const telegram = require('./telegram');
const team = require('./team');
const reminders = require('./reminders');
const archive = require('./archive');
const resources = require('./resources');
const tasksMeta = require('./tasks-meta');
const recurring = require('./recurring');

// ── Startup validation ──────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'NOTION_TOKEN',
  'NOTION_TASKS_DB_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();

// Preserve raw body so webhook.js can verify the Notion HMAC signature
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ──────────────────────────────────────────────────────────────────

// Notion webhook receiver
app.post('/webhook', handleWebhook);

// Returns Notion workspace users for the assignee picker
app.get('/users', async (req, res) => {
  try {
    const users = await notion.getWorkspaceUsers();
    res.json({ users: users.map((u) => ({ id: u.id, name: u.name })) });
  } catch (err) {
    console.error('[/users]', err.message);
    // Non-fatal — the frontend falls back to a text input
    res.json({ users: [] });
  }
});

// Returns all tasks from the Tasks database
app.get('/tasks', async (req, res) => {
  try {
    const pages = await notion.queryTasksDatabase();
    const tasks = pages.map((page) => ({
      id: page.id,
      name: notion.getTaskName(page),
      assignees: (page.properties?.['Assigned to']?.people || []).map((u) => u.name || 'Unknown'),
      dueDate: notion.getDueDate(page),
      status: notion.getStatus(page),
      priority: notion.getPriority(page),
      category: notion.getCategory(page),
      lastEdited: page.last_edited_time,
    }));
    res.json({ tasks, total: tasks.length });
  } catch (err) {
    console.error('[/tasks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Creates a new task in the Notion Tasks database
app.post('/tasks', async (req, res) => {
  const { name, assigneeId, assigneeIds, dueDate, status, priority, category } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Task name is required' });
  }
  try {
    const page = await notion.createTask({ name: name.trim(), assigneeId, assigneeIds, dueDate, status, priority, category });
    const task = {
      id: page.id,
      name: notion.getTaskName(page),
      assignees: (page.properties?.['Assigned to']?.people || []).map((u) => u.name || 'Unknown'),
      dueDate: notion.getDueDate(page),
      status: notion.getStatus(page),
      priority: notion.getPriority(page),
      category: notion.getCategory(page),
      lastEdited: page.last_edited_time,
    };
    res.status(201).json({ task });

    // Telegram: new task notification (fire-and-forget)
    const assigneeNames = req.body.assigneeNames || [];
    const tags = assigneeNames.length ? assigneeNames.map(n => team.tag(n)).join(' ') : 'Unassigned';
    const dueFmt = dueDate || 'No date set';
    const prioFmt = priority ? priority.replace(/^[^\w]+/, '').trim() : 'Not set';
    const catFmt  = category || 'Not set';
    telegram.sendMessage(
      `📌 *New task created*\n\n` +
      `Task: ${name.trim()}\n` +
      `Assigned to: ${tags}\n` +
      `Due: ${dueFmt}\n` +
      `Priority: ${prioFmt}\n` +
      `Category: ${catFmt}\n` +
      `Status: To do`
    ).catch(err => console.error('[telegram] new task:', err.message));
  } catch (err) {
    console.error('[POST /tasks]', err.message);
    res.status(500).json({ error: err.message || 'Failed to create task in Notion' });
  }
});

// Returns the SOP link for a task by name
app.get('/sop', async (req, res) => {
  const { task } = req.query;
  if (!task) {
    return res.status(400).json({ error: 'task query param is required' });
  }

  try {
    const tasks = await notion.queryTasksDatabase({
      property: 'Task name',
      title: { contains: task },
    });

    if (tasks.length === 0) {
      return res.status(404).json({ error: `No task found matching "${task}"` });
    }

    const match = tasks[0];
    return res.json({
      task: notion.getTaskName(match),
      sop: notion.getSOP(match),
    });
  } catch (err) {
    console.error('[/sop]', err.message);
    return res.status(500).json({ error: 'Failed to fetch task from Notion' });
  }
});

// Updates any fields of a task in Notion
app.patch('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body;
  const properties = {};

  if ('status' in body && body.status)
    properties['Status'] = { status: { name: body.status } };
  if ('name' in body && body.name?.trim())
    properties['Task name'] = { title: [{ text: { content: body.name.trim() } }] };
  if ('dueDate' in body)
    properties['Due date'] = body.dueDate ? { date: { start: body.dueDate } } : { date: null };
  if ('priority' in body)
    properties['Priority'] = body.priority ? { select: { name: body.priority } } : { select: null };
  if ('category' in body)
    properties['Department'] = body.category ? { select: { name: body.category } } : { select: null };
  if ('assigneeIds' in body)
    properties['Assigned to'] = body.assigneeIds?.length
      ? { people: body.assigneeIds.map(id => ({ object: 'user', id })) }
      : { people: [] };
  else if ('assigneeId' in body)
    properties['Assigned to'] = body.assigneeId
      ? { people: [{ object: 'user', id: body.assigneeId }] }
      : { people: [] };

  if (Object.keys(properties).length === 0)
    return res.status(400).json({ error: 'No fields to update' });

  try {
    await notion.updatePage(id, properties);
    if (body.status === 'Done') reminders.cancel(id);
    res.json({ ok: true });

    // Telegram notifications (fire-and-forget)
    const taskName     = body.taskName || 'Task';
    const prev         = body.previousValues || {};
    const assigneeNames = body.assigneeNames || [];
    const prevAssignees = prev.assignees || [];

    // Build changes list
    const changes = [];
    if ('status' in body && body.status && body.status !== prev.status)
      changes.push(`Status: ${prev.status || '—'} → ${body.status}`);
    if ('name' in body && body.name && body.name.trim() !== (prev.name || '').trim())
      changes.push(`Name → "${body.name.trim()}"`);
    if ('dueDate' in body && body.dueDate !== prev.dueDate)
      changes.push(`Due: ${body.dueDate || 'removed'}`);
    if ('priority' in body && body.priority !== prev.priority) {
      const p = (s) => s ? s.replace(/^[^\w]+/, '').trim() : 'removed';
      changes.push(`Priority: ${p(prev.priority)} → ${p(body.priority)}`);
    }
    if ('category' in body && body.category !== prev.category)
      changes.push(`Category: ${prev.category || '—'} → ${body.category || 'removed'}`);
    if (assigneeNames.length && JSON.stringify(assigneeNames.sort()) !== JSON.stringify([...prevAssignees].sort()))
      changes.push(`Assignees: ${assigneeNames.map(n => team.tag(n)).join(' ')}`);

    if (changes.length > 0) {
      telegram.sendMessage(
        `✏️ *Task updated: ${taskName}*\n` +
        `Changes: ${changes.join(' · ')}`
      ).catch(err => console.error('[telegram] task update:', err.message));
    }

    // Task assigned: was unassigned, now has assignees
    if (prevAssignees.length === 0 && assigneeNames.length > 0) {
      const tags = assigneeNames.map(n => team.tag(n)).join(' ');
      const due  = body.dueDate || prev.dueDate || 'No date set';
      telegram.sendMessage(
        `👤 *${taskName}* has been assigned to ${tags}\n` +
        `Due: ${due}`
      ).catch(err => console.error('[telegram] task assigned:', err.message));
    }
  } catch (err) {
    console.error('[PATCH /tasks/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reminder endpoints
app.get('/reminders', (req, res) => {
  res.json({ reminders: reminders.getAll() });
});

app.post('/reminders', (req, res) => {
  const { taskId, taskName, intervalKey, assigneeNames } = req.body;
  if (!taskId || !intervalKey) return res.status(400).json({ error: 'taskId and intervalKey required' });
  reminders.set(taskId, taskName || taskId, intervalKey);
  res.json({ ok: true, reminder: reminders.get(taskId) });

  // Telegram: reminder set notification
  const tags  = (assigneeNames || []).length ? (assigneeNames).map(n => team.tag(n)).join(' ') : 'Unassigned';
  const label = reminders.INTERVAL_LABELS[intervalKey] || intervalKey;
  telegram.sendMessage(
    `⏰ *Reminder set for: ${taskName || taskId}*\n` +
    `Assigned to: ${tags}\n` +
    `Reminding every: ${label}`
  ).catch(err => console.error('[telegram] reminder set:', err.message));
});

app.delete('/reminders/:taskId', (req, res) => {
  reminders.cancel(req.params.taskId);
  res.json({ ok: true });
});

// ── Resources endpoints ──────────────────────────────────────────────────────

app.get('/resources', (req, res) => {
  res.json({ resources: resources.getAll() });
});

app.post('/resources', (req, res) => {
  const { title, content, category } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  const resource = resources.create({ title: title.trim(), content: content || '', category: category || '' });
  res.status(201).json({ resource });
});

app.patch('/resources/:id', (req, res) => {
  const { id } = req.params;
  const updated = resources.update(id, req.body);
  if (!updated) return res.status(404).json({ error: 'Resource not found' });
  res.json({ resource: updated });
});

app.delete('/resources/:id', (req, res) => {
  const removed = resources.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Resource not found' });
  res.json({ ok: true });
});

// ── Tasks-meta endpoints ─────────────────────────────────────────────────────

app.get('/tasks-meta', (req, res) => {
  res.json({ meta: tasksMeta.getAll() });
});

app.get('/tasks-meta/:taskId', (req, res) => {
  const meta = tasksMeta.getTask(req.params.taskId);
  res.json({ meta: meta || { notes: '', sop: '', sopLink: '', resources: [] } });
});

app.patch('/tasks-meta/:taskId', (req, res) => {
  const meta = tasksMeta.updateTask(req.params.taskId, req.body);
  res.json({ ok: true, meta });
});

app.post('/tasks-meta/:taskId/resources', (req, res) => {
  const r = tasksMeta.addResource(req.params.taskId, req.body);
  res.status(201).json({ resource: r });
});

app.patch('/tasks-meta/:taskId/resources/:resId', (req, res) => {
  const r = tasksMeta.updateResource(req.params.taskId, req.params.resId, req.body);
  if (!r) return res.status(404).json({ error: 'Resource not found' });
  res.json({ resource: r });
});

app.delete('/tasks-meta/:taskId/resources/:resId', (req, res) => {
  const ok = tasksMeta.deleteResource(req.params.taskId, req.params.resId);
  if (!ok) return res.status(404).json({ error: 'Resource not found' });
  res.json({ ok: true });
});

// Returns team members for the assignee picker
app.get('/team', (req, res) => {
  res.json({ team: team.getAll() });
});

// ── Archive endpoints ────────────────────────────────────────────────────────

app.get('/archive', (req, res) => {
  res.json({ tasks: archive.getAll() });
});

app.post('/archive/:id', (req, res) => {
  const { id } = req.params;
  const { name, assignee, category, dueDate, completedAt } = req.body;
  archive.add({ id, name: name || id, assignee: assignee || '', category: category || '', dueDate: dueDate || null, completedAt: completedAt || new Date().toISOString(), status: 'Done' });
  reminders.cancel(id);
  res.json({ ok: true });
});

app.delete('/archive/:id', async (req, res) => {
  const { id } = req.params;
  archive.remove(id);
  try {
    await notion.updatePage(id, { 'Status': { status: { name: 'To do' } } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /archive/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Recurring task endpoints ─────────────────────────────────────────────────

app.get('/recurring', (req, res) => {
  res.json({ recurring: recurring.getAll() });
});

app.post('/recurring', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  const rec = recurring.create(req.body);
  res.status(201).json({ recurring: rec });
});

app.patch('/recurring/:id', (req, res) => {
  const updated = recurring.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ recurring: updated });
});

app.delete('/recurring/:id', (req, res) => {
  const ok = recurring.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/recurring/:id/toggle', (req, res) => {
  const updated = recurring.togglePause(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ recurring: updated });
});

// Returns live performance tally computed from the Tasks database
app.get('/performance', async (req, res) => {
  try {
    const data = await computePerformance();
    res.json(data);
  } catch (err) {
    console.error('[/performance]', err.message);
    res.status(500).json({ error: 'Failed to compute performance data' });
  }
});

// ── Telegram bot polling ─────────────────────────────────────────────────────

let pollingOffset = 0;

async function pollTelegram() {
  while (true) {
    try {
      const response = await telegram.getUpdates(pollingOffset);
      if (response.ok && Array.isArray(response.result)) {
        for (const update of response.result) {
          pollingOffset = update.update_id + 1;
          handleBotCommand(update).catch(console.error);
        }
      }
    } catch (err) {
      console.error('[telegram poll]', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function handleBotCommand(update) {
  const msg = update.message;
  if (!msg?.text) return;

  // Strip bot @mention for group chats: /sop@mybot → /sop
  const text = msg.text.replace(/@\w+/, '').trim();
  const chatId = msg.chat.id;

  if (!text.startsWith('/sop')) return;

  const taskName = text.slice(4).trim();
  if (!taskName) {
    await telegram.sendMessage('Usage: `/sop [task name]`', chatId);
    return;
  }

  const tasks = await notion.queryTasksDatabase({
    property: 'Task name',
    title: { contains: taskName },
  });

  if (tasks.length === 0) {
    await telegram.sendMessage(`No task found matching "${taskName}".`, chatId);
    return;
  }

  const match = tasks[0];
  const name = notion.getTaskName(match);
  const sop = notion.getSOP(match);

  if (sop) {
    await telegram.sendMessage(`SOP for *${name}*:\n${sop}`, chatId);
  } else {
    await telegram.sendMessage(`No SOP set for *${name}* — add one in Notion.`, chatId);
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  const port = process.env.PORT || 3000;

  archive.load();
  resources.load();
  tasksMeta.load();
  recurring.load();
  reminders.load();
  startScheduler();

  // Long-poll Telegram in the background — does not block the HTTP server
  pollTelegram().catch(console.error);

  app.listen(port, () => {
    console.log(`[server] Taskr listening on http://localhost:${port}`);
  });
}

start();
