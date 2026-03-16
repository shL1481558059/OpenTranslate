const fs = require('node:fs');
const path = require('node:path');

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const idx = normalized.indexOf('=');
  if (idx <= 0) {
    return null;
  }
  const key = normalized.slice(0, idx).trim();
  let value = normalized.slice(idx + 1).trim();
  if (!key) {
    return null;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

loadDotEnv();

module.exports = {
  loadDotEnv
};
