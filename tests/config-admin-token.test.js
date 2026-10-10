const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_MODULE_PATH = require.resolve('../api/config');

function loadConfigModuleWithAdminToken(token) {
  if (token === undefined) {
    delete process.env.ADMIN_TOKEN;
  } else {
    process.env.ADMIN_TOKEN = token;
  }
  delete require.cache[CONFIG_MODULE_PATH];
  return require('../api/config');
}

function makeRuntimeConfig(adminToken) {
  return {
    local: {
      argosModelDir: '/tmp/argos',
      marianModelDir: '/tmp/marian',
      pythonPath: '/tmp/python',
      venvDir: '/tmp/venv',
      timeoutMs: 20000
    },
    marian: {
      modelId: 'Helsinki-NLP/opus-mt-en-zh',
      device: 'cpu',
      dtype: 'float32',
      maxTokens: 512,
      hfEndpoint: '',
      hfDisableSslVerify: false
    },
    admin: {
      token: adminToken
    }
  };
}

test('config: runtime ADMIN_TOKEN should not override updated config token', () => {
  const previous = process.env.ADMIN_TOKEN;
  try {
    const config = loadConfigModuleWithAdminToken(undefined);
    config.applyRuntimeEnv(makeRuntimeConfig('old-runtime-token'));
    const overridden = config.__private.applyEnvOverrides({
      admin: { token: 'new-config-token' }
    });
    assert.equal(overridden.admin.token, 'new-config-token');
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = previous;
    }
    delete require.cache[CONFIG_MODULE_PATH];
  }
});

test('config: startup ADMIN_TOKEN should keep highest priority', () => {
  const previous = process.env.ADMIN_TOKEN;
  try {
    const config = loadConfigModuleWithAdminToken('external-token');
    const overridden = config.__private.applyEnvOverrides({
      admin: { token: 'new-config-token' }
    });
    assert.equal(overridden.admin.token, 'external-token');
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = previous;
    }
    delete require.cache[CONFIG_MODULE_PATH];
  }
});

test('config: startup env should override config.json engine and venv paths', () => {
  const config = loadConfigModuleWithAdminToken(undefined);
  const resolved = config.__private.applyEnvOverrides(
    {
      engine: 'marian',
      local: {
        argosModelDir: './models/argos',
        marianModelDir: './models/marian',
        pythonPath: './.venv-argos/bin/python',
        venvDir: './.venv-argos',
        timeoutMs: 20000
      },
      marian: {
        modelId: 'file-model',
        device: 'cpu',
        dtype: 'float32',
        maxTokens: 512,
        hfEndpoint: '',
        hfDisableSslVerify: false
      },
      admin: { token: '' }
    },
    {
      TRANSLATION_ENGINE: 'argos',
      LOCAL_TRANSLATE_PYTHON: './.venv/bin/python',
      LOCAL_TRANSLATE_VENV: './.venv'
    }
  );
  assert.equal(resolved.engine, 'argos');
  assert.equal(resolved.local.pythonPath, './.venv/bin/python');
  assert.equal(resolved.local.venvDir, './.venv');
  assert.equal(resolved.marian.modelId, 'file-model');
});

test('config: applyRuntimeEnv should clear ADMIN_TOKEN when token is empty', () => {
  const previous = process.env.ADMIN_TOKEN;
  try {
    const config = loadConfigModuleWithAdminToken(undefined);
    config.applyRuntimeEnv(makeRuntimeConfig(''));
    assert.equal(process.env.ADMIN_TOKEN, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = previous;
    }
    delete require.cache[CONFIG_MODULE_PATH];
  }
});
