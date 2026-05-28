const crypto = require('crypto');
const notion = require('./notion');
const telegram = require('./telegram');
const team = require('./team');

// Prevents double-counting a task completion within a single server session.
// The nightly sync recalculates everything from scratch, so any in-memory drift
// is corrected daily.
const completedTaskIds = new Set();

function verifyNotionSignature(rawBody, signature) {
  if (!process.env.NOTION_WEBHOOK_SECRET) return true;
  if (!signature) return false;

  const eqIdx = signature.indexOf('=');
  if (eqIdx === -1) return false;
  const version = signature.slice(0, eqIdx);
  const hash = signature.slice(eqIdx + 1);
  if (version !== 'v0') return false;

  const expected = crypto
    .createHmac('sha256', process.env.NOTION_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function handleWebhook(req, res) {
  // Notion verification handshake — sent once during webhook setup
  if (req.body?.verification_token) {
    console.log('[webhook] Notion verification handshake received');
    return res.status(200).json({ ok: true });
  }

  const signature = req.headers['x-notion-signature'];
  if (!verifyNotionSignature(req.rawBody, signature)) {
    console.warn('[webhook] Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ error: 'Empty or invalid body' });
  }

  console.log(`[webhook] Event received: ${event.type || 'unknown'}`);

  try {
    await routeEvent(event);
    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook] Routing error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function routeEvent(event) {
  // Notion webhook events carry the page ID under entity
  const pageId = event.entity?.id;
  if (!pageId || event.entity?.type !== 'page') return;

  const page = await notion.getPage(pageId);

  // Confirm this page belongs to the tasks database by checking for its title prop
  if (!page.properties?.['Task name']) return;

  const status = notion.getStatus(page);
  const assignees = notion.getAssigneeNames(page);
  const taskName = notion.getTaskName(page);

  if (status === 'Complete' && !completedTaskIds.has(pageId)) {
    completedTaskIds.add(pageId);
    const tags = assignees.length ? assignees.map(a => team.tag(a)).join(' ') : 'someone';
    await telegram.sendMessage(`✅ *${taskName}* marked complete by ${tags}`);
  }
}

module.exports = { handleWebhook };
