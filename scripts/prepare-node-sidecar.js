const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NODE_VERSION = process.env.OPENTRANSLATE_NODE_VERSION || '22.14.0';
const outDir = path.join(__dirname, '../desktop/src-tauri/binaries');

const PACKAGES = {
  'x86_64-unknown-linux-gnu': {
    archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`,
    inner: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    name: 'opentranslate-node-x86_64-unknown-linux-gnu'
  },
  'aarch64-unknown-linux-gnu': {
    archive: `node-v${NODE_VERSION}-linux-arm64.tar.xz`,
    inner: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    name: 'opentranslate-node-aarch64-unknown-linux-gnu'
  },
  'x86_64-apple-darwin': {
    archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    inner: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    name: 'opentranslate-node-x86_64-apple-darwin'
  },
  'aarch64-apple-darwin': {
    archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    inner: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    name: 'opentranslate-node-aarch64-apple-darwin'
  },
  'x86_64-pc-windows-msvc': {
    archive: `node-v${NODE_VERSION}-win-x64.zip`,
    inner: `node-v${NODE_VERSION}-win-x64/node.exe`,
    name: 'opentranslate-node-x86_64-pc-windows-msvc.exe'
  }
};

function hostTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) {
    return process.env.TAURI_ENV_TARGET_TRIPLE;
  }
  if (process.env.OPENTRANSLATE_TARGET) {
    return process.env.OPENTRANSLATE_TARGET;
  }
  const arch = os.arch();
  if (process.platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (process.platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (process.platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported host ${process.platform} ${arch}`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`);
  }
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const spec = PACKAGES[hostTriple()];
  if (!spec) {
    throw new Error(`no Node sidecar package for ${hostTriple()}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const destination = path.join(outDir, spec.name);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 1000000) {
    console.log(`[node-sidecar] keep ${destination}`);
    return;
  }
  const archivePath = path.join(os.tmpdir(), spec.archive);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${spec.archive}`;
  console.log(`[node-sidecar] download ${url}`);
  await download(url, archivePath);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentranslate-node-'));
  execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });
  fs.copyFileSync(path.join(extractDir, spec.inner), destination);
  fs.chmodSync(destination, 0o755);
  console.log(`[node-sidecar] wrote ${destination}`);
}

main().catch((error) => {
  console.error(`[node-sidecar] ${error.message}`);
  process.exit(1);
});
