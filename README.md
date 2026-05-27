# Ecommerce Task Tracker

Node.js service that connects Notion, Telegram, and a performance tally engine to keep an ecommerce team on top of their tasks.

## What it does

- **Daily digest** — Telegram message at 9am listing every task due today, grouped by assignee, with priority, category, and SOP link
- **Overdue alert** — Telegram message at 6pm flagging tasks that are past due
- **Completion notification** — Instant Telegram message when any task is marked Complete in Notion
- **Weekly report** — Monday 9am performance table (assigned / done / missed / rate) with top performer
- **Performance database** — Synced on startup and recalculated from scratch every midnight
- **`/sop` bot command** — Reply in Telegram with the SOP link for any task by name
- **REST endpoints** — `/sop?task=...` and `/performance` for external use

---

## Requirements

- Node.js 18 or later (uses the built-in `fetch` API)
- A Notion workspace with admin or integration access
- A Telegram bot token from BotFather

---

## Setup

### 1. Install dependencies

```bash
cd task-tracker
npm install
```

### 2. Create the Notion databases

You need two databases in Notion. Create them manually or duplicate the templates below.

#### Tasks database

| Property | Type | Options |
|---|---|---|
| Task name | Title | — |
| Assignee | Person | — |
| Due date | Date | — |
| Status | Select | Not started, In progress, Complete, Blocked |
| SOP | URL | — |
| Priority | Select | High, Medium, Low |
| Category | Select | Ads, Fulfillment, Creative, Finance, Operations |

#### Performance database

| Property | Type | Notes |
|---|---|---|
| Member name | Title | — |
| Tasks assigned | Number | — |
| Tasks completed | Number | — |
| Tasks missed | Number | — |
| Completion rate | Formula | `prop("Tasks completed") / prop("Tasks assigned")` |
| Last updated | Date | — |

### 3. Create a Notion integration

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations) and click **New integration**
2. Give it a name (e.g. "Task Tracker"), select your workspace
3. Under **Capabilities**, enable **Read content**, **Update content**, **Insert content**
4. Copy the **Internal Integration Token** — this is your `NOTION_TOKEN`
5. Open each database in Notion, click the `...` menu → **Add connections** → select your integration

### 4. Get the database IDs

Open each database in Notion. The URL looks like:

```
https://www.notion.so/yourworkspace/abc123def456...?v=...
```

The 32-character string before the `?` is the database ID. Copy both IDs into `.env`.

### 5. Set up the Notion webhook

Notion webhooks require your server to be publicly reachable. For local development, use [ngrok](https://ngrok.com):

```bash
ngrok http 3000
# Note the https://xxxx.ngrok.io URL
```

Then register the webhook via the Notion API:

```bash
curl -X POST https://api.notion.com/v1/webhooks \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-public-url.com/webhook",
    "event_types": ["page.property_item.updated"],
    "resource_type": "page",
    "database_id": "'"$NOTION_TASKS_DB_ID"'"
  }'
```

Notion will POST a `{ "verification_token": "..." }` to `/webhook`. The server responds automatically — check the logs for `Notion verification handshake received`.

Copy the `signing_secret` from the response into `NOTION_WEBHOOK_SECRET` in `.env`.

### 6. Create the Telegram bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the bot token into `TELEGRAM_BOT_TOKEN`
4. Add the bot to your team's group chat
5. Send any message in the group, then visit:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Find the `"chat": { "id": ... }` value for the group — that's your `TELEGRAM_CHAT_ID` (a negative number)
6. In BotFather, send `/setprivacy` → select your bot → choose **Disable** so the bot can see all group messages (required for the `/sop` command)

### 7. Configure environment

```bash
cp .env.example .env
# Fill in all values
```

### 8. Run

```bash
npm start
```

On startup the server will:
1. Validate all required environment variables
2. Sync the performance database from all current Notion tasks
3. Register all cron jobs
4. Begin long-polling Telegram for bot commands
5. Start listening on the configured port

---

## API Reference

### `POST /webhook`

Receives Notion webhook events. Handles the Notion verification handshake automatically.

### `GET /sop?task=<name>`

Returns the SOP link for the first task whose name contains the query string.

```json
{ "task": "Update ad creatives", "sop": "https://..." }
```

Returns `404` if no matching task is found. Returns `{ "sop": null }` if the task exists but has no SOP.

### `GET /performance`

Returns the full performance tally as a JSON array.

```json
[
  { "name": "Harry", "assigned": 8, "completed": 7, "missed": 1, "completionRate": 87 },
  { "name": "Saamir", "assigned": 6, "completed": 4, "missed": 2, "completionRate": 67 }
]
```

---

## Bot Commands

### `/sop [task name]`

The bot searches Notion for a task whose name contains the given text and replies with its SOP link. Works in the group chat and in direct messages to the bot.

Examples:
```
/sop ad creatives
/sop fulfillment queue
```

---

## Scheduled Jobs

| Time | Job |
|---|---|
| 9:00am daily | Daily digest — tasks due today |
| 6:00pm daily | Overdue alert — past-due incomplete tasks |
| 9:00am Monday | Weekly performance report |
| 12:00am daily | Full performance sync from Notion |

All times use the server's local timezone. To target a specific timezone, set `TZ` before starting:

```bash
TZ=America/New_York npm start
```

---

## Architecture

```
src/
  index.js      Entry point — starts HTTP server, cron jobs, Telegram polling
  notion.js     All Notion REST API calls (paginated queries, page reads/writes)
  telegram.js   All Telegram Bot API calls (sendMessage, getUpdates)
  tally.js      Performance sync and incremental count updates
  scheduler.js  Cron job definitions and message formatters
  webhook.js    Notion webhook receiver, HMAC verification, event router
```

The tally engine uses two strategies together:

1. **Real-time incremental updates** on every webhook event (fast, may drift if events are missed)
2. **Full sync from scratch at midnight** (slow, always accurate — fixes any drift)

The performance database is the source of truth for `/performance` and the weekly report.
