const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'team.json'), 'utf8')
);

function lookup(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return DATA.find(
    m => lower.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(lower)
  ) || null;
}

function tag(name) {
  const member = lookup(name);
  return member ? `@${member.telegram}` : (name || 'Unassigned');
}

function getAll() {
  return DATA;
}

module.exports = { lookup, tag, getAll };
