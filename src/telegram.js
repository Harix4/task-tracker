const TELEGRAM_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_ENABLED) {
  console.warn('[telegram] WARNING: TELEGRAM_BOT_TOKEN not set - notifications disabled');
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramRequest(method, payload) {
  if (!TELEGRAM_ENABLED) return { ok: false, description: 'Bot token not set' };
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const data = await res.json();
    const retryAfter = data.parameters?.retry_after ?? 1;
    console.log(`Telegram rate limited. Retrying in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return telegramRequest(method, payload);
  }

  const data = await res.json();

  if (!data.ok) {
    console.error(`Telegram ${method} failed:`, data.description);
  }

  return data;
}

async function sendMessage(text, chatId = process.env.TELEGRAM_CHAT_ID) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

// ── Notification queue ────────────────────────────────────────────────────────
// Serialises all outbound messages so rapid task creation never loses a
// notification to Telegram's 30 msg/s rate limit. Each send is separated by
// 300 ms; a 429 response triggers an automatic back-off retry via sendMessage.

const _notifQueue = [];
let   _notifSending = false;

async function _processQueue() {
  if (_notifSending) return;
  _notifSending = true;
  while (_notifQueue.length > 0) {
    const { text, chatId } = _notifQueue.shift();
    try {
      await sendMessage(text, chatId);
    } catch (err) {
      console.error('[telegram queue] send failed:', err.message);
    }
    // 300 ms breathing room between sends (Telegram allows ~30 msg/s)
    await new Promise(r => setTimeout(r, 300));
  }
  _notifSending = false;
}

/**
 * Queue a Telegram notification for sequential delivery.
 * Drop-in replacement for sendMessage() — same (text, chatId) signature.
 * Returns immediately; actual send happens asynchronously via the queue.
 */
function queueNotification(text, chatId = process.env.TELEGRAM_CHAT_ID) {
  _notifQueue.push({ text, chatId });
  _processQueue(); // kick off if idle
  return Promise.resolve(); // callers can optionally await
}

async function setWebhook(url) {
  return telegramRequest('setWebhook', { url });
}

let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try {
    const res = await telegramRequest('getMe', {});
    _botUsername = res?.result?.username || '';
    return _botUsername;
  } catch { return ''; }
}

module.exports = { sendMessage, queueNotification, setWebhook, getBotUsername };
