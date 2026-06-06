const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'team.json'), 'utf8')
);

// Hardcoded aliases for names that contain numbers or unusual characters
// that can trip up substring matching against Notion assignee strings.
const ALIASES = {
  'n1ka': 'N1ka',
};

// Bidirectional, case-insensitive name match.
// Special-cases numeric names like "N1ka" to avoid false positives.
function _match(a, b) {
  if (!a || !b) return false;
  a = String(a).toLowerCase().trim();
  b = String(b).toLowerCase().trim();
  if (a === b) return true;
  // For numeric names, only allow exact match (no substring)
  if (ALIASES[a] || ALIASES[b]) return a === b;
  return a.includes(b) || b.includes(a);
}

function lookup(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase().trim();
  // Resolve alias first (e.g. "n1ka" → "N1ka")
  const resolved = ALIASES[lower] || name;
  const member   = DATA.find(m => _match(m.name, resolved));
  if (member && lower === 'n1ka') {
    console.log('[team] lookup N1ka → telegram:', member.telegram);
  }
  return member || null;
}

// Produce "@telegramHandle" for a given display name.
function tag(name) {
  const member = lookup(name);
  if (member) return `@${member.telegram}`;
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
