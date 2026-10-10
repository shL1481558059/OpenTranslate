const { spawn } = require('node:child_process');
const path = require('node:path');

const cli = path.join(__dirname, '../node_modules/@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '../desktop'),
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
