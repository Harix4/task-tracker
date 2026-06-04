const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'team.json'), 'utf8')
);

// Bidirectional, case-insensitive name match (same logic as namesMatch in index.js)
function _match(a, b) {
  if (!a || !b) return false;
  a = String(a).toLowerCase().trim();
  b = String(b).toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

function lookup(name) {
  if (!name) return null;
  return DATA.find(m => _match(m.name, name)) || null;
}

// Produce "@telegramHandle" for a given display name.
// Falls back to "@name" if not found so notifications always
// produce a mention-like string rather than a bare name.
function tag(name) {
  const member = lookup(name);
  if (member) return `@${member.telegram}`;
  // Unknown member — prefix with @ so it still looks like a mention
  return name ? `@${name}` : 'Unassigned';
}

// Build a space-joined tag string for an array of assignee names
function tagList(names) {
  if (!names?.length) return 'Unassigned';
  return names.map(tag).join(' ');
}

function getAll() {
  return DATA;
}

// Return the default IANA timezone for a team member, or null if not set
function getTz(name) {
  const member = lookup(name);
  return (member && member.tz) ? member.tz : null;
}

module.exports = { lookup, tag, tagList, getAll, getTz };
