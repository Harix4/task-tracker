// ── N1ka and other special-name overrides ────────────────────────────────────
// Map any variation of a member's display name → their Telegram username.
// This is the final safety net — checked before any other lookup.
const TELEGRAM_OVERRIDES = {
  'n1ka':  'Abduu_19',
  'nika':  'Abduu_19',
  'N1ka':  'Abduu_19',
  'N1Ka':  'Abduu_19',
  'N1KA':  'Abduu_19',
};

/**
 * Return the Telegram @handle for a given member display name.
 * Checks TELEGRAM_OVERRIDES first so N1ka always resolves regardless of
 * how team.json or Notion spelled the name.
 */
function getTelegramUsername(name, teamData) {
  if (!name) return null;
  const trimmed = name.trim();
  const override = TELEGRAM_OVERRIDES[trimmed];
  if (override) {
    console.log(`[telegram] override: "${trimmed}" → @${override}`);
    return override;
  }
  if (!teamData) return null;
  const member = teamData.find(
    m => m.name.toLowerCase().trim() === trimmed.toLowerCase()
  );
  return member ? member.telegram : null;
}

const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_ENABLED) {
  console.warn('[telegram] WARNING: TELEGRAM_BOT_TOKEN not set - notifications disabled');
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

// Single HTTP send with one automatic retry on failure
async function _doSend(payload) {
  const res = await fetch(apiUrl('sendMessage'), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const wait = (data.parameters?.retry_after ?? 1) * 1000;
    console.log(`[telegram] rate limited — waiting ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    return _doSend(payload); // recursive retry for rate limit
  }
  const data = await res.json().catch(() => ({ ok: false, description: 'JSON parse failed' }));
  return data;
}

async function telegramRequest(method, payload) {
  if (!TELEGRAM_ENABLED) return { ok: false, description: 'Bot token not set' };
  const res = await fetch(apiUrl(method), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const wait = (data.parameters?.retry_after ?? 1) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return telegramRequest(method, payload);
  }
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.error(`[telegram] ${method} failed:`, data.description);
  return data;
}

/**
 * Send a message with one automatic retry on non-rate-limit failure.
 * Logs success or failure clearly — never silently drops.
 */
async function sendMessage(text, chatId = process.env.TELEGRAM_CHAT_ID) {
  if (!chatId || !text) {
    console.log('[telegram] skipped — missing chatId or text');
    return { ok: false };
  }
  if (!TELEGRAM_ENABLED) {
    console.log('[telegram] skipped — bot token not set');
    return { ok: false };
  }
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  };
  const result = await _doSend(payload);
  if (result.ok) {
    console.log(`[telegram] ✅ sent to chatId ${String(chatId).slice(0, 6)}…`);
  } else {
    console.warn(`[telegram] ❌ first attempt failed (${result.description}) — retrying in 500ms`);
    await new Promise(r => setTimeout(r, 500));
    const retry = await _doSend(payload);
    if (retry.ok) {
      console.log(`[telegram] ✅ retry succeeded to chatId ${String(chatId).slice(0, 6)}…`);
    } else {
      console.error(`[telegram] ❌ retry also failed: ${retry.description}`);
    }
    return retry;
  }
  return result;
}

// ── Notification queue ────────────────────────────────────────────────────────
const _notifQueue   = [];
let   _notifSending = false;

async function _processQueue() {
  if (_notifSending) return;
  _notifSending = true;
  while (_notifQueue.length > 0) {
    const { text, chatId } = _notifQueue.shift();
    try { await sendMessage(text, chatId); }
    catch (err) { console.error('[telegram queue] unexpected error:', err.message); }
    await new Promise(r => setTimeout(r, 300));
  }
  _notifSending = false;
}

function queueNotification(text, chatId = process.env.TELEGRAM_CHAT_ID) {
  _notifQueue.push({ text, chatId });
  _processQueue();
  return Promise.resolve();
}

async function setWebhook(url) {
  return telegramRequest('setWebhook', { url });
}

let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try {
    const res  = await telegramRequest('getMe', {});
    _botUsername = res?.result?.username || '';
    return _botUsername;
  } catch { return ''; }
}

module.exports = { sendMessage, queueNotification, setWebhook, getBotUsername, getTelegramUsername, TELEGRAM_OVERRIDES };
