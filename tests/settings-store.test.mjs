// tako:run: node --test ${fileDir}/*.test.mjs
// SettingsStore（localStorage 永続化層）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';

import { SettingsStore } from '../js/SettingsStore.js';
import { createFakeStorage } from './helpers.mjs';

test('音量を保存すると、次回の起動（新しいインスタンス）で復元される', () => {
  const storage = createFakeStorage();
  new SettingsStore({ storage }).setVolume('fanfare', 0.42);

  // リロード相当: 同じストレージに対して新しいインスタンスを作る
  const reloaded = new SettingsStore({ storage });
  assert.equal(reloaded.getVolume('fanfare', 1), 0.42);
});

test('未保存の音源は fallback（manifest の defaultVolume）を返す', () => {
  const settings = new SettingsStore({ storage: createFakeStorage() });
  assert.equal(settings.getVolume('unknown', 0.7), 0.7);
});

test('音量は 0〜1 に丸められ、壊れた値は fallback / 0 になる', () => {
  const storage = createFakeStorage();
  const settings = new SettingsStore({ storage });

  settings.setVolume('a', 5);
  assert.equal(settings.getVolume('a', 1), 1);

  settings.setVolume('b', -3);
  assert.equal(settings.getVolume('b', 1), 0);

  settings.setVolume('c', 'あ');
  assert.equal(settings.getVolume('c', 1), 0);

  // ストレージに直接壊れた値が入っていた場合は fallback へ戻す
  storage.setItem('sampler:volume:d', 'broken');
  assert.equal(settings.getVolume('d', 0.6), 0.6);
});

test('起動時プリロード設定は既定 false で、保存すると復元される', () => {
  const storage = createFakeStorage();
  const settings = new SettingsStore({ storage });
  assert.equal(settings.getPreloadAll(), false);

  settings.setPreloadAll(true);
  assert.equal(new SettingsStore({ storage }).getPreloadAll(), true);

  settings.setPreloadAll(false);
  assert.equal(new SettingsStore({ storage }).getPreloadAll(), false);
});

test('キーには接頭辞が付き、他アプリの値と衝突しない', () => {
  const storage = createFakeStorage();
  new SettingsStore({ storage }).setVolume('fanfare', 0.5);
  assert.deepEqual([...storage.map.keys()], ['sampler:volume:fanfare']);
});

test('ストレージが例外を投げても落ちず、既定値で動作を継続する', () => {
  const hostileStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const settings = new SettingsStore({ storage: hostileStorage });
  assert.doesNotThrow(() => settings.setVolume('a', 0.3));
  assert.equal(settings.getVolume('a', 0.9), 0.9);
  assert.doesNotThrow(() => settings.setPreloadAll(true));
  assert.equal(settings.getPreloadAll(), false);
});

test('localStorage へのアクセス自体が例外になる環境（プライベートモード等）でも動く', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: localStorage is disabled');
    },
  });
  try {
    const settings = new SettingsStore();
    assert.equal(settings.isPersistent, false);
    // メモリへフォールバックするので、このタブ内では値を保持できる
    settings.setVolume('a', 0.25);
    assert.equal(settings.getVolume('a', 1), 0.25);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
