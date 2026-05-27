require('dotenv').config();

const express = require('express');
const path = require('path');
const { handleWebhook } = require('./webhook');
const { startScheduler } = require('./scheduler');
const { computePerformance } = require('./tally');
const notion = require('./notion');
const telegram = require('./telegram');

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
      sop: notion.getSOP(page),
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
  const { name, assigneeId, dueDate, status, priority, category, sop } = req.body;
  if (!name?.trim()) {
    return res.status(400).json({ error: 'Task name is required' });
  }
  try {
    const page = await notion.createTask({ name: name.trim(), assigneeId, dueDate, status, priority, category, sop });
    const task = {
      id: page.id,
      name: notion.getTaskName(page),
      assignees: (page.properties?.['Assigned to']?.people || []).map((u) => u.name || 'Unknown'),
      dueDate: notion.getDueDate(page),
      status: notion.getStatus(page),
      priority: notion.getPriority(page),
      category: notion.getCategory(page),
      sop: notion.getSOP(page),
      lastEdited: page.last_edited_time,
    };
    res.status(201).json({ task });
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

  startScheduler();

  // Long-poll Telegram in the background — does not block the HTTP server
  pollTelegram().catch(console.error);

  app.listen(port, () => {
    console.log(`[server] Taskr listening on http://localhost:${port}`);
  });
}

start();
