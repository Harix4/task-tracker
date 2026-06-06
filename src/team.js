const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'team.json'), 'utf8')
);

// ── Hardcoded overrides ────────────────────────────────────────────────────
// Members whose names contain numbers or special characters that can
// trip up fuzzy matching. These are resolved BEFORE any regex/includes logic.
// Key = any lowercase variation that might appear in Notion or the codebase.
const HARDCODED_LOOKUP = {
  'n1ka':  { name: 'N1ka',  telegram: 'Abduu_19',  tz: 'Asia/Tbilisi' },
};

// Return the hardcoded record if the name matches any known alias.
function _hardcoded(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase().trim();
  return HARDCODED_LOOKUP[lower] || null;
}

// Bidirectional, case-insensitive name match (standard names only).
function _match(a, b) {
  if (!a || !b) return false;
  a = String(a).toLowerCase().trim();
  b = String(b).toLowerCase().trim();
  return a === b || a.includes(b) || b.includes(a);
}

function lookup(name) {
  if (!name) return null;
  // Check hardcoded table first — guaranteed correct for special names
  const hard = _hardcoded(name);
  if (hard) {
    console.log(`[team] lookup hardcoded: "${name}" → telegram:${hard.telegram}`);
    return hard;
  }
  return DATA.find(m => _match(m.name, name)) || null;
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
