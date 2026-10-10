const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function defaultVenvPython(venvDir) {
  const root = venvDir || path.join(process.cwd(), '.venv');
  if (process.platform === 'win32') {
    return path.join(root, 'Scripts', 'python.exe');
  }
  return path.join(root, 'bin', 'python');
}

function isLegacyUnixPython(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  return normalized === './.venv/bin/python' || normalized === '.venv/bin/python' || normalized.endsWith('/.venv/bin/python');
}

function resolvePythonPath(venvDir, explicit) {
  const value = String(explicit || '').trim();
  if (!value || (process.platform === 'win32' && isLegacyUnixPython(value))) {
    return defaultVenvPython(venvDir);
  }
  return value;
}

async function findLauncher() {
  const candidates = process.platform === 'win32'
    ? [['py', '-3'], ['python'], ['python3']]
    : [['python3'], ['python']];
  let lastError = null;
  for (const [command, ...prefix] of candidates) {
    try {
      await execFileAsync(command, [...prefix, '--version']);
      return { command, prefix };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(lastError?.message || 'python_not_found');
  error.code = 'python_not_found';
  throw error;
}

async function ensureVenv(venvDir) {
  const launcher = await findLauncher();
  console.log(`[python] creating virtualenv ${venvDir}`);
  await execFileAsync(launcher.command, [...launcher.prefix, '-m', 'venv', venvDir]);
}

async function pipInstall(pythonPath, requirementsPath, label) {
  console.log(`[python] installing ${label}: ${requirementsPath}`);
  try {
    await execFileAsync(pythonPath, ['-m', 'pip', 'install', '-r', requirementsPath]);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    const wrapped = new Error(`安装${label}失败：${detail}`);
    wrapped.code = 'pip_install_failed';
    throw wrapped;
  }
  console.log(`[python] installed ${label}`);
}

module.exports = {
  defaultVenvPython,
  resolvePythonPath,
  isLegacyUnixPython,
  findLauncher,
  ensureVenv,
  pipInstall
};
