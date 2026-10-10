const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '../node_modules/@awesome.me/webawesome/dist-cdn');
const target = path.join(__dirname, '../desktop/ui/vendor/webawesome');

if (!fs.existsSync(source)) {
  console.error(`[sync-ui-vendor] missing ${source}. Run npm install at the repository root.`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });
console.log(`[sync-ui-vendor] copied webawesome to ${target}`);
