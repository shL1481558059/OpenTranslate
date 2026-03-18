const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function getModelDir(config) {
  const dir = config?.local?.argosModelDir || path.join(process.cwd(), 'models', 'argos');
  return path.resolve(dir);
}

function getPythonPath(config) {
  return path.resolve(config?.local?.pythonPath || path.join(process.cwd(), '.venv', 'bin', 'python'));
}

function buildPythonEnv(modelDir, config) {
  const xdgRoot = path.join(modelDir, '.xdg');
  const env = {
    ...process.env,
    LOCAL_TRANSLATE_MODEL_DIR: modelDir,
    XDG_DATA_HOME: path.join(xdgRoot, 'data'),
    XDG_CACHE_HOME: path.join(xdgRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(xdgRoot, 'config')
  };
  if (config?.local?.venvDir) {
    env.VIRTUAL_ENV = config.local.venvDir;
  }
  return env;
}

function parseModelFilename(name) {
  const match = String(name || '').match(/^(.+?)-([^.]+)\.argosmodel$/);
  if (!match) return null;
  return { from: match[1], to: match[2] };
}

function listInstalled(config) {
  const modelDir = getModelDir(config);
  try {
    fs.mkdirSync(modelDir, { recursive: true });
  } catch {
    // ignore
  }
  let entries = [];
  try {
    entries = fs.readdirSync(modelDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.argosmodel'))
    .map((name) => {
      const parsed = parseModelFilename(name);
      return {
        from: parsed?.from || null,
        to: parsed?.to || null,
        filename: name
      };
    });
}

async function listAvailable(config) {
  const pythonPath = getPythonPath(config);
  if (!fs.existsSync(pythonPath)) {
    const error = new Error('python_not_found');
    error.code = 'python_not_found';
    throw error;
  }
  const scriptPath = path.resolve(__dirname, 'download_model.py');
  const modelDir = getModelDir(config);
  fs.mkdirSync(modelDir, { recursive: true });
  const { stdout } = await execFileAsync(pythonPath, [scriptPath, 'list', modelDir], {
    env: buildPythonEnv(modelDir, config)
  });
  const text = String(stdout || '').trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('invalid_model_list');
  }
  return parsed;
}

async function downloadModel(config, from, to) {
  const pythonPath = getPythonPath(config);
  if (!fs.existsSync(pythonPath)) {
    const error = new Error('python_not_found');
    error.code = 'python_not_found';
    throw error;
  }
  const scriptPath = path.resolve(__dirname, 'download_model.py');
  const modelDir = getModelDir(config);
  fs.mkdirSync(modelDir, { recursive: true });
  await execFileAsync(pythonPath, [scriptPath, 'download', modelDir, String(from), String(to)], {
    env: buildPythonEnv(modelDir, config)
  });
  return { ok: true };
}

function removeModel(config, filename) {
  const modelDir = getModelDir(config);
  const resolved = path.resolve(modelDir, filename);
  if (!(resolved === modelDir || resolved.startsWith(`${modelDir}${path.sep}`))) {
    const error = new Error('invalid_model_path');
    error.code = 'invalid_model_path';
    throw error;
  }
  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }
  return { ok: true };
}

module.exports = {
  getModelDir,
  listInstalled,
  listAvailable,
  downloadModel,
  removeModel
};
