const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const venvDir = path.join(projectRoot, '.venv-argos');
const frameworkRoot =
  process.env.PYTHON_FRAMEWORK_PATH ||
  '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9';

const stdlibSrc = path.join(frameworkRoot, 'lib', 'python3.9');
const stdlibDst = path.join(venvDir, 'lib', 'python3.9');
const pythonLibSrc = path.join(frameworkRoot, 'Python3');
const pythonLibDst = path.join(venvDir, 'Python3');
const zipSrc = path.join(frameworkRoot, 'lib', 'python39.zip');
const zipDst = path.join(venvDir, 'lib', 'python39.zip');
const resourcesSrc = path.join(frameworkRoot, 'Resources');
const resourcesDst = path.join(venvDir, 'Resources');

function die(message) {
  console.error(`[prepare-python-runtime] ${message}`);
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst, excludeNames = new Set()) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  ensureDir(dst);
  for (const entry of entries) {
    if (excludeNames.has(entry.name)) {
      continue;
    }
    if (entry.name === 'site-packages') {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      try {
        fs.symlinkSync(target, to);
      } catch {
        // If symlink fails, fall back to copying the resolved file.
        const resolved = path.resolve(path.dirname(from), target);
        if (fs.existsSync(resolved)) {
          copyFile(resolved, to);
        }
      }
      continue;
    }
    if (stat.isDirectory()) {
      copyTree(from, to, excludeNames);
      continue;
    }
    copyFile(from, to);
  }
}

if (!fs.existsSync(venvDir)) {
  die(`找不到 venv 目录：${venvDir}`);
}

if (!fs.existsSync(frameworkRoot)) {
  die(
    `找不到系统 Python Framework：${frameworkRoot}\n` +
      '请安装 Xcode Command Line Tools 或设置 PYTHON_FRAMEWORK_PATH。'
  );
}

if (!fs.existsSync(stdlibSrc)) {
  die(`找不到标准库目录：${stdlibSrc}`);
}

if (!fs.existsSync(pythonLibSrc)) {
  die(`找不到 Python 运行时库：${pythonLibSrc}`);
}

copyFile(pythonLibSrc, pythonLibDst);
if (fs.existsSync(zipSrc)) {
  copyFile(zipSrc, zipDst);
}
copyTree(stdlibSrc, stdlibDst, new Set(['site-packages']));
if (fs.existsSync(resourcesSrc)) {
  copyTree(resourcesSrc, resourcesDst);
}

console.log('[prepare-python-runtime] embedded Python runtime ready.');
