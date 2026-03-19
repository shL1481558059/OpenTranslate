const test = require('node:test');
const assert = require('node:assert/strict');

const marianManager = require('../api/local/marian_manager');
const { __internal } = require('../api/server');

test('resolveSourceLang should detect French when source_lang is auto', () => {
  const resolved = __internal.resolveSourceLang(
    [{ id: 'b1', text: 'Bonjour tout le monde' }],
    'auto'
  );
  assert.equal(resolved.sourceLang, 'fr');
  assert.equal(resolved.detectedSourceLang, 'fr');
});

test('shouldPassthroughText should only bypass when source and target are the same language', () => {
  assert.equal(__internal.shouldPassthroughText('你好，世界', 'zh-CN', 'zh'), true);
  assert.equal(__internal.shouldPassthroughText('你好，世界', 'zh-CN', 'en'), false);
  assert.equal(__internal.shouldPassthroughText('', 'zh-CN', 'en'), true);
});

test('mergeById should preserve empty translated strings', () => {
  const merged = __internal.mergeById(
    [{ id: 'b1', text: '' }],
    [{ id: 'b1', translated_text: '', confidence: 1 }]
  );
  assert.equal(merged[0].translated_text, '');
});

test('resolveMarianModelSelection should choose an installed model that matches the requested pair', () => {
  const originalListInstalled = marianManager.listInstalled;
  marianManager.listInstalled = () => [
    {
      model_id: 'Helsinki-NLP/opus-mt-zh-en',
      local_dir: '/tmp/zh-en-model',
      from: 'zh',
      to: 'en'
    }
  ];

  try {
    const selection = __internal.resolveMarianModelSelection(
      {
        local: { marianModelDir: '/tmp/marian-models' },
        marian: { modelId: 'Helsinki-NLP/opus-mt-en-zh' }
      },
      'zh-CN',
      'en'
    );
    assert.equal(selection.modelId, 'Helsinki-NLP/opus-mt-zh-en');
    assert.equal(selection.localDir, '/tmp/zh-en-model');
  } finally {
    marianManager.listInstalled = originalListInstalled;
  }
});

test('resolveMarianModelSelection should fall back to recommended models for supported pairs', () => {
  const originalListInstalled = marianManager.listInstalled;
  marianManager.listInstalled = () => [];

  try {
    const selection = __internal.resolveMarianModelSelection(
      {
        local: { marianModelDir: '/tmp/marian-models' },
        marian: { modelId: 'Helsinki-NLP/opus-mt-en-zh' }
      },
      'fr',
      'en'
    );
    assert.equal(selection.modelId, 'Helsinki-NLP/opus-mt-fr-en');
  } finally {
    marianManager.listInstalled = originalListInstalled;
  }
});

test('resolveMarianModelSelection should reject unsupported translation pairs', () => {
  const originalListInstalled = marianManager.listInstalled;
  marianManager.listInstalled = () => [];

  try {
    assert.throws(
      () =>
        __internal.resolveMarianModelSelection(
          {
            local: { marianModelDir: '/tmp/marian-models' },
            marian: { modelId: 'Helsinki-NLP/opus-mt-en-zh' }
          },
          'es',
          'de'
        ),
      /no_translation_pair:es->de/
    );
  } finally {
    marianManager.listInstalled = originalListInstalled;
  }
});
