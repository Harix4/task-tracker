const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest(path, method = 'GET', body = null) {
  const url = `${NOTION_API_BASE}${path}`;
  const token = process.env.NOTION_TOKEN;
  console.log(`[notion] ${method} ${url} | token=${token ? token.slice(0, 12) + '…' : 'MISSING'}`);

  const options = { method, headers: headers() };
  if (body !== null) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  console.log(`[notion] ${method} ${path} → HTTP ${res.status}`);

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
    console.log(`[notion] Rate limited. Retrying in ${retryAfter}s…`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return notionRequest(path, method, body);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[notion] Error body:`, JSON.stringify(err));
    throw new Error(`Notion API ${method} ${path} → ${res.status}: ${err.message || res.statusText}`);
  }

  const data = await res.json();
  if (data.results !== undefined) {
    console.log(`[notion] ${method} ${path} → ${data.results.length} result(s), has_more=${data.has_more}`);
  }
  return data;
}

async function paginatedQuery(databaseId, filter = null, sorts = null) {
  const results = [];
  let cursor;

  do {
    const body = {};
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const page = await notionRequest(`/databases/${databaseId}/query`, 'POST', body);
    results.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function queryTasksDatabase(filter = null) {
  const dbId = process.env.NOTION_TASKS_DB_ID;
  console.log(`[notion] queryTasksDatabase: DB_ID=${dbId ? dbId.slice(0, 8) + '…' : 'MISSING'}`);
  return paginatedQuery(dbId, filter);
}

async function getWorkspaceUsers() {
  const data = await notionRequest('/users');
  return (data.results || []).filter((u) => u.type === 'person');
}

async function createTask({ name, assigneeId, assigneeIds, dueDate, status, priority, category, sop }) {
  const properties = {
    'Task name': { title: [{ text: { content: name } }] },
  };
  if (status)     properties['Status']   = { status: { name: status } };
  if (priority)   properties['Priority'] = { select: { name: priority } };
  if (category)   properties['Department'] = { select: { name: category } };
  if (dueDate)    properties['Due date'] = { date: { start: dueDate } };
  if (sop?.trim()) properties['SOP']     = { url: sop.trim() };
  if (assigneeIds?.length) properties['Assigned to'] = { people: assigneeIds.map(id => ({ object: 'user', id })) };
  else if (assigneeId) properties['Assigned to'] = { people: [{ object: 'user', id: assigneeId }] };

  return notionRequest('/pages', 'POST', {
    parent: { database_id: process.env.NOTION_TASKS_DB_ID },
    properties,
  });
}

async function queryPerformanceDatabase(filter = null) {
  return paginatedQuery(process.env.NOTION_PERFORMANCE_DB_ID, filter);
}

async function getPage(pageId) {
  return notionRequest(`/pages/${pageId}`);
}

async function updatePage(pageId, properties) {
  return notionRequest(`/pages/${pageId}`, 'PATCH', { properties });
}

async function createPerformancePage(memberName, assigned, completed, missed) {
  return notionRequest('/pages', 'POST', {
    parent: { database_id: process.env.NOTION_PERFORMANCE_DB_ID },
    properties: buildPerformanceProperties(memberName, assigned, completed, missed),
  });
}

function buildPerformanceProperties(memberName, assigned, completed, missed) {
  return {
    'Member name': { title: [{ text: { content: memberName } }] },
    'Tasks assigned': { number: assigned },
    'Tasks completed': { number: completed },
    'Tasks missed': { number: missed },
    'Last updated': { date: { start: new Date().toISOString().split('T')[0] } },
  };
}

// ── Property extractors ─────────────────────────────────────────────────────

function getTitle(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.title?.[0]?.plain_text ?? '';
}

function getTaskName(page) {
  return getTitle(page, 'Task name');
}

function getMemberName(page) {
  return getTitle(page, 'Member name');
}

function getAssigneeName(page) {
  const people = page.properties?.['Assigned to']?.people;
  if (!people || people.length === 0) return null;
  return people[0].name ?? null;
}

function getAssigneeNames(page) {
  const people = page.properties?.['Assigned to']?.people;
  if (!people || people.length === 0) return [];
  return people.map(u => u.name || 'Unknown');
}

function getDueDate(page) {
  return page.properties?.['Due date']?.date?.start ?? null;
}

function getStatus(page) {
  return page.properties?.Status?.status?.name ?? null;
}

function getPriority(page) {
  return page.properties?.Priority?.select?.name ?? null;
}

function getCategory(page) {
  return page.properties?.Department?.select?.name ?? null;
}

function getSOP(page) {
  const prop = page.properties?.SOP;
  if (!prop) return null;
  if (prop.url) return prop.url;
  if (prop.rich_text?.length > 0) return prop.rich_text[0].plain_text;
  return null;
}

function getNumber(page, propName) {
  return page.properties?.[propName]?.number ?? 0;
}

module.exports = {
  queryTasksDatabase,
  queryPerformanceDatabase,
  getWorkspaceUsers,
  createTask,
  getPage,
  updatePage,
  createPerformancePage,
  buildPerformanceProperties,
  getTaskName,
  getMemberName,
  getAssigneeName,
  getAssigneeNames,
  getDueDate,
  getStatus,
  getPriority,
  getCategory,
  getSOP,
  getNumber,
};
