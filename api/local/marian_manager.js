const path = require('node:path');
const fs = require('node:fs');
const marianClient = require('./marian_client');
const { writeJsonAtomic } = require('../config');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'marian_models.json');

function getModelDirRoot(config) {
  const dir = config?.local?.marianModelDir || path.join(process.cwd(), 'models', 'marian');
  return path.resolve(dir);
}

function encodeModelId(modelId) {
  return String(modelId || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function loadManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function saveManifest(next) {
  writeJsonAtomic(MANIFEST_PATH, next);
}

function listInstalled(config) {
  const root = getModelDirRoot(config);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // ignore
  }
  let manifest = loadManifest();
  const filtered = manifest.filter((entry) => entry && entry.model_id && entry.local_dir);
  let existing = filtered.filter((entry) => fs.existsSync(entry.local_dir));
  if (existing.length === 0) {
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
      existing = dirs
        .map((dir) => {
          const localDir = path.join(root, dir.name);
          const metaPath = path.join(localDir, 'model.json');
          if (!fs.existsSync(metaPath)) return null;
          try {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed?.model_id) {
              return { model_id: parsed.model_id, local_dir: localDir, added_at: null };
            }
          } catch {
            return null;
          }
          return null;
        })
        .filter(Boolean);
      if (existing.length > 0) {
        manifest = existing.map((entry) => ({ ...entry, added_at: entry.added_at || null }));
        saveManifest(manifest);
      }
    } catch {
      // ignore
    }
  }
  return existing.map((entry) => ({
    model_id: entry.model_id,
    local_dir: entry.local_dir,
    added_at: entry.added_at || null
  }));
}

async function downloadModel(config, modelId) {
  const root = getModelDirRoot(config);
  fs.mkdirSync(root, { recursive: true });
  const localDir = path.join(root, encodeModelId(modelId));
  await marianClient.downloadModel({
    modelId,
    localDir,
    device: config?.marian?.device,
    dtype: config?.marian?.dtype
  });
  const metaPath = path.join(localDir, 'model.json');
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(metaPath, JSON.stringify({ model_id: modelId }, null, 2), 'utf8');
  }
  const manifest = loadManifest();
  const filtered = manifest.filter((entry) => entry?.model_id !== modelId);
  filtered.push({ model_id: modelId, local_dir: localDir, added_at: new Date().toISOString() });
  saveManifest(filtered);
  return { ok: true, model_id: modelId, local_dir: localDir };
}

function removeModel(config, modelId) {
  const root = getModelDirRoot(config);
  const manifest = loadManifest();
  const entry = manifest.find((item) => item?.model_id === modelId);
  const localDir = entry?.local_dir || path.join(root, encodeModelId(modelId));
  const resolved = path.resolve(localDir);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    const error = new Error('invalid_model_path');
    error.code = 'invalid_model_path';
    throw error;
  }
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  const filtered = manifest.filter((item) => item?.model_id !== modelId);
  saveManifest(filtered);
  return { ok: true };
}

module.exports = {
  listInstalled,
  downloadModel,
  removeModel
};
