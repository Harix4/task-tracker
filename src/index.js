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
const auth = require('./auth');
const personal = require('./personal');
const redis = require('./redis-client');

// ── Redis helpers for comments + history ─────────────────────────────────────

function parseR(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function genCid() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

async function addTaskHistory(taskId, entry) {
  const key     = `task:history:${taskId}`;
  const raw     = await redis.get(key);
  const history = parseR(raw) || [];
  history.unshift({ id: genCid(), ...entry, at: new Date().toISOString() });
  if (history.length > 100) history.length = 100;
  await redis.set(key, history);
}

// ── Startup validation ──────────────────────────────────────────────────────

const REQUIRED_ENV = [
  'NOTION_TOKEN',
  'NOTION_TASKS_DB_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  // UPSTASH_REDIS_REST_URL / TOKEN are optional locally; the redis-client module
  // falls back to an in-memory stub when they are absent.
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

// ── Auth routes ──────────────────────────────────────────────────────────────

// Returns member list for the login screen (no auth required)
app.get('/auth/members', (req, res) => {
  res.json({ members: auth.MEMBERS.map(({ username, displayName, role, initials }) =>
    ({ username, displayName, role, initials })
  )});
});

// Login: POST { username, pin } → { token }
app.post('/auth/login', async (req, res) => {
  const { username, pin, timezone } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'username and pin required' });
  try {
    const ok = await auth.verifyPin(username, String(pin));
    if (!ok) return res.status(401).json({ error: 'Incorrect PIN' });
    const token = auth.createToken(username);
    if (!token) return res.status(400).json({ error: 'Unknown member' });
    // Persist the user's browser timezone for reminders / scheduling
    if (timezone) {
      auth.saveTimezone(username, timezone).catch(err =>
        console.warn('[auth] saveTimezone:', err.message)
      );
    }
    const resolvedTz  = timezone || await auth.getTimezone(username);
    const member      = auth.getMember(username);
    const isAdmin     = member?.role === 'admin';
    // Admin skips setup; everyone else sees it once
    const setupDone   = isAdmin || await auth.isSetupComplete(username);
    res.json({ token, timezone: resolvedTz, setupRequired: !setupDone });
  } catch (err) {
    console.error('[POST /auth/login]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Return the bot's Telegram username (used by setup screen)
app.get('/auth/bot', async (req, res) => {
  try {
    const username = await telegram.getBotUsername();
    res.json({ username });
  } catch { res.json({ username: '' }); }
});

// Mark first-time setup as complete + persist chosen timezone
app.post('/auth/setup', auth.requireAuth, async (req, res) => {
  try {
    const { timezone } = req.body;
    if (timezone) await auth.saveTimezone(req.user.username, timezone);
    await auth.markSetupComplete(req.user.username);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /auth/setup]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Change own PIN: POST { currentPin, newPin }
// Admin change anyone's PIN: POST { newPin, targetUsername } (no currentPin check)
app.post('/auth/pin', auth.requireAuth, async (req, res) => {
  const { currentPin, newPin, targetUsername } = req.body;
  const isAdmin  = req.user.role === 'admin';
  const changing = isAdmin && targetUsername ? targetUsername : req.user.username;
  if (!newPin || String(newPin).length !== 4 || !/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  try {
    // Non-admin always verifies current PIN; admin can skip when changing others
    if (!isAdmin || changing === req.user.username) {
      if (!currentPin) return res.status(400).json({ error: 'currentPin required' });
      const ok = await auth.verifyPin(changing, String(currentPin));
      if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect' });
    }
    await auth.setPin(changing, newPin);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /auth/pin]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Personal task routes (auth required) ─────────────────────────────────────

// Helper: send a DM to a named team member if they have a registered chat ID
async function dmMember(memberName, text) {
  const member = team.lookup(memberName);
  if (!member) return;
  const chatId = await personal.getChatId(member.telegram);
  if (!chatId) return;
  return telegram.sendMessage(text, chatId).catch(err =>
    console.warn('[personal DM]', memberName, err.message)
  );
}

// GET own tasks + collab tasks merged
app.get('/personal/tasks', auth.requireAuth, async (req, res) => {
  try {
    const [own, collab] = await Promise.all([
      personal.getTasks(req.user.username),
      personal.getCollabTasks(req.user.username),
    ]);
    res.json({ tasks: [...own, ...collab] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create task, notify collaborators
app.post('/personal/tasks', auth.requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Task name required' });
  try {
    const task = await personal.addTask(req.user.username, req.body);

    // Set reminder
    if (task.reminderInterval && reminders.INTERVAL_MINUTES[task.reminderInterval]) {
      await reminders.setPersonal(req.user.username, task.id, task.name, task.reminderInterval, req.user.telegram);
    }

    // Notify collaborators via Telegram DM
    if (task.collaborators?.length) {
      const creator  = req.user.displayName || req.user.username;
      const tz       = await auth.getTimezone(req.user.username);
      const dueStr   = task.dueDate
        ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' })
        : 'No due date';
      for (const collab of task.collaborators) {
        dmMember(collab,
          `👥 *${creator} shared a task with you:*\n` +
          `${task.name}\n` +
          `Due: ${dueStr}\n` +
          `You can view it in your Personal tab on Klone HQ.`
        );
      }
    }

    res.status(201).json({ task });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update task — supports editing as creator OR collaborator
app.patch('/personal/tasks/:id', auth.requireAuth, async (req, res) => {
  try {
    const actingUser    = req.user.username;
    const taskId        = req.params.id;
    const ownerUsername = req.body.creatorUsername || actingUser;

    // Fetch task to verify access
    const existing = await personal.getTask(ownerUsername, taskId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const isCreator = ownerUsername === actingUser;
    const isCollab  = (existing.collaborators || []).includes(actingUser);
    if (!isCreator && !isCollab) return res.status(403).json({ error: 'Access denied' });

    // Strip routing field before storing
    const { creatorUsername: _skip, ...fields } = req.body;
    const updated = await personal.updateTask(ownerUsername, taskId, fields);
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    // Handle reminder interval change
    const interval = fields.reminderInterval;
    if (interval !== undefined) {
      const ownerMember = auth.getMember(ownerUsername);
      if (interval && reminders.INTERVAL_MINUTES[interval]) {
        await reminders.setPersonal(ownerUsername, taskId, updated.name, interval, ownerMember?.telegram || req.user.telegram);
      } else {
        await reminders.cancelPersonal(ownerUsername, taskId);
      }
    }

    // Mark done → cancel reminder + notify collaborators
    if (fields.status === 'done') {
      await reminders.cancelPersonal(ownerUsername, taskId);
      const doneBy = req.user.displayName || actingUser;
      const msg    = `✅ *${updated.name}* has been completed by *${doneBy}*`;

      // Notify all collaborators
      for (const collab of (updated.collaborators || [])) {
        if (collab !== actingUser) dmMember(collab, msg);
      }
      // Notify creator if a collaborator was the one who marked it done
      if (!isCreator) dmMember(ownerUsername, msg);
    }

    res.json({ task: { ...updated, _creatorUsername: isCollab ? ownerUsername : undefined } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete task — creator only
app.delete('/personal/tasks/:id', auth.requireAuth, async (req, res) => {
  try {
    const taskId = req.params.id;
    // Collab members can only delete from own tasks (creator owns the record)
    const ok = await personal.deleteTask(req.user.username, taskId);
    await reminders.cancelPersonal(req.user.username, taskId);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notion webhook receiver ───────────────────────────────────────────────────

// Notion webhook receiver
app.post('/webhook', handleWebhook);

// ── Telegram webhook receiver ─────────────────────────────────────────────────

app.post('/telegram-webhook', async (req, res) => {
  // Acknowledge immediately — Telegram expects 200 within a few seconds
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (!msg?.text) return;

    // Strip bot @mention: /register@MyBot → /register
    const text    = msg.text.replace(/@\w+/, '').trim();
    const chatId  = String(msg.chat.id);
    const tgUser  = msg.from?.username;

    if (text !== '/register') return;

    if (!tgUser) {
      await telegram.sendMessage(
        '❌ No Telegram username found on your account. Set one in Telegram Settings → Username, then try again.',
        chatId
      );
      return;
    }

    // Check the username is a known team member
    const member = team.lookup(tgUser);
    await personal.setChatId(tgUser, chatId);

    const name = member ? member.name : `@${tgUser}`;
    await telegram.sendMessage(
      `✅ Registered! You'll now receive personal task reminders as DMs.`,
      chatId
    );
    console.log(`[telegram-webhook] /register: ${name} (@${tgUser}) chatId=${chatId}`);
  } catch (err) {
    console.error('[telegram-webhook]', err.message);
  }
});

// ── Task Comments ─────────────────────────────────────────────────────────────

app.get('/tasks/:id/comments', auth.requireAuth, async (req, res) => {
  try {
    const raw      = await redis.get(`task:comments:${req.params.id}`);
    const comments = parseR(raw) || [];
    res.json({ comments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/tasks/:id/comments', auth.requireAuth, async (req, res) => {
  const { text, taskName } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  try {
    const key      = `task:comments:${req.params.id}`;
    const raw      = await redis.get(key);
    const comments = parseR(raw) || [];
    const comment  = {
      id:          genCid(),
      author:      req.user.username,
      displayName: req.user.displayName || req.user.username,
      text:        text.trim(),
      createdAt:   new Date().toISOString(),
    };
    comments.push(comment);
    await redis.set(key, comments);

    // Track in history
    addTaskHistory(req.params.id, { action: 'comment_added', by: req.user.username, snippet: text.trim().slice(0, 80) }).catch(() => {});

    // Telegram group notification
    const author = req.user.displayName || req.user.username;
    telegram.sendMessage(
      `💬 *${author}* commented on *${taskName || 'a task'}*:\n${text.trim().slice(0, 200)}`,
      process.env.TELEGRAM_CHAT_ID
    ).catch(() => {});

    res.json({ comment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/tasks/:id/comments/:commentId', auth.requireAuth, async (req, res) => {
  try {
    const key      = `task:comments:${req.params.id}`;
    const raw      = await redis.get(key);
    const comments = (parseR(raw) || []).filter(c => c.id !== req.params.commentId);
    await redis.set(key, comments);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Task History ──────────────────────────────────────────────────────────────

app.get('/tasks/:id/history', auth.requireAuth, async (req, res) => {
  try {
    const raw     = await redis.get(`task:history:${req.params.id}`);
    const history = parseR(raw) || [];
    res.json({ history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// Returns tasks from Notion.
// Admin → all tasks.  Member → only tasks assigned to them or unassigned.
app.get('/tasks', auth.requireAuth, async (req, res) => {
  try {
    const pages = await notion.queryTasksDatabase();
    let tasks = pages.map((page) => ({
      id: page.id,
      name: notion.getTaskName(page),
      assignees: (page.properties?.['Assigned to']?.people || []).map((u) => u.name || 'Unknown'),
      dueDate: notion.getDueDate(page),
      status: notion.getStatus(page),
      priority: notion.getPriority(page),
      category: notion.getCategory(page),
      lastEdited: page.last_edited_time,
    }));
    if (req.user.role === 'member') {
      const me = req.user.username;
      // Members see ONLY tasks explicitly assigned to them — no unassigned tasks
      tasks = tasks.filter(t => (t.assignees || []).includes(me));
    }
    res.json({ tasks, total: tasks.length });
  } catch (err) {
    console.error('[/tasks]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Creates a new task in the Notion Tasks database
app.post('/tasks', auth.requireAdmin, async (req, res) => {
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

    // Track creation in history
    addTaskHistory(task.id, { action: 'task_created', by: req.user.username }).catch(() => {});

    // Team task created → group chat only
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
      `Status: To do`,
      process.env.TELEGRAM_CHAT_ID
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
app.patch('/tasks/:id', auth.requireAuth, async (req, res) => {
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
    if (body.status === 'Done') await reminders.cancel(id);
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
        `Changes: ${changes.join(' · ')}`,
        process.env.TELEGRAM_CHAT_ID
      ).catch(err => console.error('[telegram] task update:', err.message));
    }

    // Task assigned: was unassigned, now has assignees
    if (prevAssignees.length === 0 && assigneeNames.length > 0) {
      const tags = assigneeNames.map(n => team.tag(n)).join(' ');
      const due  = body.dueDate || prev.dueDate || 'No date set';
      telegram.sendMessage(
        `👤 *${taskName}* has been assigned to ${tags}\n` +
        `Due: ${due}`,
        process.env.TELEGRAM_CHAT_ID
      ).catch(err => console.error('[telegram] task assigned:', err.message));
    }

    // History tracking (fire-and-forget)
    const actor = req.user.username;
    if ('status' in body && body.status && body.status !== prev.status) {
      if (body.status === 'Done')
        addTaskHistory(id, { action: 'task_completed', by: actor }).catch(() => {});
      else
        addTaskHistory(id, { action: 'status_changed', from: prev.status || 'None', to: body.status, by: actor }).catch(() => {});
    }
    if ('dueDate' in body && body.dueDate !== prev.dueDate)
      addTaskHistory(id, { action: 'due_date_changed', from: prev.dueDate || 'None', to: body.dueDate || 'None', by: actor }).catch(() => {});
    if ('name' in body && body.name && body.name.trim() !== (prev.name || '').trim())
      addTaskHistory(id, { action: 'name_changed', from: prev.name, to: body.name.trim(), by: actor }).catch(() => {});
    if (assigneeNames.length && JSON.stringify([...assigneeNames].sort()) !== JSON.stringify([...prevAssignees].sort()))
      addTaskHistory(id, { action: 'assignee_changed', from: prevAssignees, to: assigneeNames, by: actor }).catch(() => {});
  } catch (err) {
    console.error('[PATCH /tasks/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reminder endpoints
app.get('/reminders', async (req, res) => {
  try {
    res.json({ reminders: await reminders.getAll() });
  } catch (err) {
    console.error('[GET /reminders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reminders', async (req, res) => {
  const { taskId, taskName, intervalKey, assigneeNames } = req.body;
  if (!taskId || !intervalKey) return res.status(400).json({ error: 'taskId and intervalKey required' });
  try {
    await reminders.set(taskId, taskName || taskId, intervalKey);
    const reminder = await reminders.get(taskId);
    res.json({ ok: true, reminder });

    // Team reminder set → group chat only
    const tags  = (assigneeNames || []).length ? assigneeNames.map(n => team.tag(n)).join(' ') : 'Unassigned';
    const label = reminders.INTERVAL_LABELS[intervalKey] || intervalKey;
    telegram.sendMessage(
      `⏰ *Reminder set for: ${taskName || taskId}*\n` +
      `Assigned to: ${tags}\n` +
      `Reminding every: ${label}`,
      process.env.TELEGRAM_CHAT_ID
    ).catch(err => console.error('[telegram] reminder set:', err.message));
  } catch (err) {
    console.error('[POST /reminders]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/reminders/:taskId', async (req, res) => {
  try {
    await reminders.cancel(req.params.taskId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /reminders]', err.message);
    res.status(500).json({ error: err.message });
  }
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

// Admin → all completed tasks.  Member → only tasks they were assigned to.
app.get('/archive', auth.requireAuth, (req, res) => {
  let tasks = archive.getAll();
  if (req.user.role === 'member') {
    const me = req.user.username;
    tasks = tasks.filter(t => t.assignee === me);
  }
  res.json({ tasks });
});

app.post('/archive/:id', async (req, res) => {
  const { id } = req.params;
  const { name, assignee, category, dueDate, completedAt } = req.body;
  archive.add({ id, name: name || id, assignee: assignee || '', category: category || '', dueDate: dueDate || null, completedAt: completedAt || new Date().toISOString(), status: 'Done' });
  await reminders.cancel(id);
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

// ── Export endpoint ──────────────────────────────────────────────────────────

// Returns all data as JSON for manual backup
app.get('/export', async (req, res) => {
  try {
    res.json({
      exportedAt: new Date().toISOString(),
      archive:    archive.getAll(),
      resources:  resources.getAll(),
      tasksMeta:  tasksMeta.getAll(),
      recurring:  recurring.getAll(),
      reminders:  await reminders.getAll(),
    });
  } catch (err) {
    console.error('[GET /export]', err.message);
    res.status(500).json({ error: err.message });
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

// ── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  const port = process.env.PORT || 3000;

  // Auto-initialise PINs on first boot
  try {
    const ready = await auth.isPinsInitialized();
    if (!ready) await auth.initDefaultPins();
  } catch (err) {
    console.error('[auth] PIN init error:', err.message);
  }

  archive.load();
  resources.load();
  tasksMeta.load();
  recurring.load();
  await reminders.load();
  await startScheduler();

  app.listen(port, async () => {
    console.log(`[server] Taskr listening on http://localhost:${port}`);

    // Register Telegram webhook so /register DMs are delivered here
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domain) {
      const webhookUrl = `https://${domain}/telegram-webhook`;
      try {
        const result = await telegram.setWebhook(webhookUrl);
        if (result.ok) {
          console.log(`[telegram] webhook registered → ${webhookUrl}`);
        } else {
          console.warn('[telegram] setWebhook failed:', result.description);
        }
      } catch (err) {
        console.error('[telegram] setWebhook error:', err.message);
      }
    } else {
      console.log('[telegram] RAILWAY_PUBLIC_DOMAIN not set — skipping webhook registration (use ngrok locally)');
    }
  });
}

start();
