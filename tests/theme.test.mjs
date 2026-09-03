// tako:run: node --test ${fileDir}/*.test.mjs
// ThemeController（テーマの解決・永続化・OS 追従）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';

import { ThemeController, ThemeMode } from '../js/ThemeController.js';
import { SettingsStore } from '../js/SettingsStore.js';
import { createFakeStorage } from './helpers.mjs';

/** matchMedia の戻り値の代わり。matches を後から変えて OS 側の変更を模す */
function createFakeMedia(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    /** OS のテーマが変わったことにする */
    emit(nextMatches) {
      this.matches = nextMatches;
      for (const listener of listeners) listener({ matches: nextMatches });
    },
  };
}

function createFakeRoot() {
  return { dataset: {} };
}

test('既定はシステム設定に従い、OS がライトなら light を適用する', () => {
  const root = createFakeRoot();
  const settings = new SettingsStore({ storage: createFakeStorage() });
  const theme = new ThemeController({ settings, root, media: createFakeMedia(false) }).init();

  assert.equal(theme.mode, ThemeMode.SYSTEM);
  assert.equal(theme.resolvedTheme, 'light');
  assert.equal(root.dataset.theme, 'light');
});

test('システム設定に従うとき、OS がダークなら dark を適用する', () => {
  const root = createFakeRoot();
  const settings = new SettingsStore({ storage: createFakeStorage() });
  const theme = new ThemeController({ settings, root, media: createFakeMedia(true) }).init();

  assert.equal(theme.resolvedTheme, 'dark');
  assert.equal(root.dataset.theme, 'dark');
});

test('システム設定に従うとき、実行中の OS のテーマ変更に追従する', () => {
  const root = createFakeRoot();
  const media = createFakeMedia(false);
  const settings = new SettingsStore({ storage: createFakeStorage() });
  const theme = new ThemeController({ settings, root, media }).init();
  assert.equal(root.dataset.theme, 'light');

  media.emit(true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.resolvedTheme, 'dark');

  media.emit(false);
  assert.equal(root.dataset.theme, 'light');
});

test('ライト / ダークを明示した場合は OS の変更に引きずられない', () => {
  const root = createFakeRoot();
  const media = createFakeMedia(false);
  const settings = new SettingsStore({ storage: createFakeStorage() });
  const theme = new ThemeController({ settings, root, media }).init();

  theme.setMode(ThemeMode.DARK);
  assert.equal(root.dataset.theme, 'dark');
  media.emit(true);
  assert.equal(root.dataset.theme, 'dark');
  media.emit(false);
  assert.equal(root.dataset.theme, 'dark');

  theme.setMode(ThemeMode.LIGHT);
  assert.equal(root.dataset.theme, 'light');
  media.emit(true);
  assert.equal(root.dataset.theme, 'light');
});

test('選択は保存され、次回の起動（新しいインスタンス）で復元される', () => {
  const storage = createFakeStorage();
  const media = createFakeMedia(false);
  new ThemeController({
    settings: new SettingsStore({ storage }),
    root: createFakeRoot(),
    media,
  }).init().setMode(ThemeMode.DARK);

  assert.equal(storage.getItem('sampler:theme'), 'dark');

  // リロード相当
  const root = createFakeRoot();
  const reloaded = new ThemeController({
    settings: new SettingsStore({ storage }),
    root,
    media,
  }).init();
  assert.equal(reloaded.mode, ThemeMode.DARK);
  assert.equal(root.dataset.theme, 'dark');
});

test('システムへ戻すと OS 追従に復帰する', () => {
  const storage = createFakeStorage();
  const root = createFakeRoot();
  const media = createFakeMedia(true);
  const theme = new ThemeController({
    settings: new SettingsStore({ storage }),
    root,
    media,
  }).init();

  theme.setMode(ThemeMode.LIGHT);
  assert.equal(root.dataset.theme, 'light');

  theme.setMode(ThemeMode.SYSTEM);
  assert.equal(storage.getItem('sampler:theme'), 'system');
  assert.equal(root.dataset.theme, 'dark'); // OS がダークなので dark に戻る
  media.emit(false);
  assert.equal(root.dataset.theme, 'light');
});

test('壊れた保存値や未知の値はシステム設定に従う扱いになる', () => {
  for (const broken of ['solarized', '', 'DARK', '123']) {
    const storage = createFakeStorage();
    storage.setItem('sampler:theme', broken);
    const root = createFakeRoot();
    const theme = new ThemeController({
      settings: new SettingsStore({ storage }),
      root,
      media: createFakeMedia(true),
    }).init();
    assert.equal(theme.mode, ThemeMode.SYSTEM, `値: ${JSON.stringify(broken)}`);
    assert.equal(root.dataset.theme, 'dark');
  }
});

test('matchMedia が無い環境でも落ちず、ライトとして扱う', () => {
  const root = createFakeRoot();
  const theme = new ThemeController({
    settings: new SettingsStore({ storage: createFakeStorage() }),
    root,
    media: null,
  }).init();
  assert.equal(theme.resolvedTheme, 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.doesNotThrow(() => theme.setMode(ThemeMode.DARK));
  assert.equal(root.dataset.theme, 'dark');
});

test('localStorage が使えなくてもテーマ切り替えは動く（保存されないだけ）', () => {
  const hostileStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const root = createFakeRoot();
  const theme = new ThemeController({
    settings: new SettingsStore({ storage: hostileStorage }),
    root,
    media: createFakeMedia(false),
  }).init();

  assert.equal(theme.mode, ThemeMode.SYSTEM);
  assert.doesNotThrow(() => theme.setMode(ThemeMode.DARK));
  assert.equal(root.dataset.theme, 'dark');
});

test('テーマ変更は購読者へ通知される', () => {
  const root = createFakeRoot();
  const media = createFakeMedia(false);
  const theme = new ThemeController({
    settings: new SettingsStore({ storage: createFakeStorage() }),
    root,
    media,
  });
  const seen = [];
  const unsubscribe = theme.subscribe((controller) => seen.push(controller.resolvedTheme));
  theme.init();
  theme.setMode(ThemeMode.DARK);
  media.emit(true);
  unsubscribe();
  theme.setMode(ThemeMode.LIGHT);

  assert.deepEqual(seen, ['light', 'dark']);
});
