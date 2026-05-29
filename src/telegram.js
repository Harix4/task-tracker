function apiUrl(method) {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function telegramRequest(method, payload) {
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

async function setWebhook(url) {
  return telegramRequest('setWebhook', { url });
}

module.exports = { sendMessage, setWebhook };
