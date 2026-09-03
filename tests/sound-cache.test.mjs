// tako:run: node --test ${fileDir}/*.test.mjs
// Sound / SoundLibrary（音源キャッシュと manifest 駆動）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';

import { Sound, SoundState } from '../js/Sound.js';
import { SoundLibrary } from '../js/SoundLibrary.js';
import { SettingsStore } from '../js/SettingsStore.js';
import { createMockEngine, createMockFetch, createFakeStorage } from './helpers.mjs';

const MANIFEST_URL = 'sounds/manifest.json';

function manifestRoutes(entries) {
  const routes = { [MANIFEST_URL]: { json: { sounds: entries } } };
  for (const entry of entries) {
    routes[`sounds/${entry.file}`] = { bytes: 64 };
  }
  return routes;
}

const BASE_ENTRIES = [
  { id: 'fanfare', name: 'ファンファーレ', icon: '🎺', file: 'fanfare.wav', defaultVolume: 0.8 },
  { id: 'drumroll', name: 'ドラムロール', icon: '🥁', file: 'drumroll.wav', defaultVolume: 0.7 },
];

test('load() を繰り返しても fetch とデコードは 1 回だけ（AudioBuffer キャッシュ）', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
  const sound = new Sound(BASE_ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

  await sound.load();
  await sound.load();
  await sound.load();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(engine.decodeCount, 1);
  assert.equal(sound.isLoaded, true);
  assert.equal(sound.state, SoundState.READY);
});

test('同時に load() が走っても fetch は 1 回に集約される', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
  const sound = new Sound(BASE_ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

  await Promise.all([sound.load(), sound.load(), sound.load()]);
  assert.equal(fetchImpl.calls.length, 1);
});

test('2 回鳴らしても再取得は発生せず、再生中フラグが正しく遷移する', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
  const sound = new Sound(BASE_ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

  await sound.play();
  assert.equal(sound.isPlaying, true);
  assert.equal(sound.state, SoundState.PLAYING);

  sound.stop();
  assert.equal(sound.isPlaying, false);
  assert.equal(sound.state, SoundState.READY);

  await sound.play();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(engine.decodeCount, 1);
  assert.equal(sound.isPlaying, true);
});

test('連打しても例外にならず、鳴っているのは最後の 1 つだけ', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
  const sound = new Sound(BASE_ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

  for (let i = 0; i < 20; i++) {
    await sound.play();
    sound.stop();
    await sound.play();
  }
  sound.stop();

  assert.equal(sound.isPlaying, false);
  assert.equal(fetchImpl.calls.length, 1);
});

test('取得に失敗すると ERROR になり、再度呼べば再試行できる', async () => {
  const engine = createMockEngine();
  // 最初は 404、2 回目から成功するよう差し替える
  let available = false;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!available) return { ok: false, status: 404, async arrayBuffer() {} };
    return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(64); } };
  };
  const sound = new Sound(BASE_ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

  await assert.rejects(() => sound.load(), /HTTP 404/);
  assert.equal(sound.state, SoundState.ERROR);
  assert.equal(sound.isLoaded, false);

  available = true;
  await sound.load();
  assert.equal(sound.state, SoundState.READY);
  assert.equal(calls.length, 2);
});

test('manifest のエントリ数だけ Sound が作られ、URL が manifest 基準で解決される', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch(manifestRoutes(BASE_ENTRIES));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, fetchImpl });

  await library.loadManifest();
  assert.equal(library.size, 2);
  assert.deepEqual(
    library.sounds.map((sound) => sound.url),
    ['sounds/fanfare.wav', 'sounds/drumroll.wav'],
  );
  assert.equal(library.get('fanfare').name, 'ファンファーレ');
  assert.equal(library.get('fanfare').icon, '🎺');
});

test('manifest にエントリを足すだけで音源が増える（JS の変更は不要）', async () => {
  const engine = createMockEngine();
  const extended = [
    ...BASE_ENTRIES,
    { id: 'applause', name: '拍手', icon: '👏', file: 'applause.wav', defaultVolume: 0.9 },
  ];
  const fetchImpl = createMockFetch(manifestRoutes(extended));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, fetchImpl });

  await library.loadManifest();
  assert.equal(library.size, 3);
  assert.equal(library.get('applause').url, 'sounds/applause.wav');
});

test('保存済みの音量が manifest の defaultVolume より優先される', async () => {
  const storage = createFakeStorage();
  storage.setItem('sampler:volume:drumroll', '0.25');
  const settings = new SettingsStore({ storage });
  const engine = createMockEngine();
  const fetchImpl = createMockFetch(manifestRoutes(BASE_ENTRIES));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, settings, fetchImpl });

  await library.loadManifest();
  assert.equal(library.get('fanfare').volume, 0.8); // 未保存なので defaultVolume
  assert.equal(library.get('drumroll').volume, 0.25); // 保存値が優先
});

test('setVolume は Sound へ反映され、同時に永続化される', async () => {
  const storage = createFakeStorage();
  const settings = new SettingsStore({ storage });
  const engine = createMockEngine();
  const fetchImpl = createMockFetch(manifestRoutes(BASE_ENTRIES));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, settings, fetchImpl });
  await library.loadManifest();

  library.setVolume('fanfare', 0.33);
  assert.equal(library.get('fanfare').volume, 0.33);
  assert.equal(new SettingsStore({ storage }).getVolume('fanfare', 1), 0.33);
});

test('preloadAll は進捗を通知し、一部が失敗しても残りを読み込む', async () => {
  const engine = createMockEngine();
  const routes = manifestRoutes(BASE_ENTRIES);
  delete routes['sounds/drumroll.wav']; // 片方だけ 404 にする
  const fetchImpl = createMockFetch(routes);
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, fetchImpl });
  await library.loadManifest();

  const progress = [];
  const result = await library.preloadAll((done, total) => progress.push(`${done}/${total}`));

  assert.deepEqual(result, { total: 2, loaded: 1, failed: 1 });
  assert.equal(progress[0], '0/2');
  assert.equal(progress.at(-1), '2/2');
  assert.equal(library.get('fanfare').isLoaded, true);
  assert.equal(library.get('drumroll').state, SoundState.ERROR);
});

test('preloadAll の後は再生しても再取得しない', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch(manifestRoutes(BASE_ENTRIES));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, fetchImpl });
  await library.loadManifest();
  await library.preloadAll();

  const before = fetchImpl.calls.length; // manifest 1 + 音源 2 = 3
  await library.get('fanfare').play();
  await library.get('drumroll').play();
  assert.equal(before, 3);
  assert.equal(fetchImpl.calls.length, before);
});

test('stopAll ですべての再生が止まる', async () => {
  const engine = createMockEngine();
  const fetchImpl = createMockFetch(manifestRoutes(BASE_ENTRIES));
  const library = new SoundLibrary({ engine, manifestUrl: MANIFEST_URL, fetchImpl });
  await library.loadManifest();

  await library.get('fanfare').play();
  await library.get('drumroll').play();
  assert.equal(library.sounds.filter((sound) => sound.isPlaying).length, 2);

  library.stopAll();
  assert.equal(library.sounds.filter((sound) => sound.isPlaying).length, 0);
});

test('壊れた manifest はエラーになる', async () => {
  const engine = createMockEngine();
  const cases = [
    { json: { sounds: 'not-an-array' } },
    { json: { sounds: [{ name: 'id がない' }] } },
    { json: { sounds: [BASE_ENTRIES[0], BASE_ENTRIES[0]] } }, // id 重複
  ];
  for (const route of cases) {
    const library = new SoundLibrary({
      engine,
      manifestUrl: MANIFEST_URL,
      fetchImpl: createMockFetch({ [MANIFEST_URL]: route }),
    });
    await assert.rejects(() => library.loadManifest());
  }

  const missing = new SoundLibrary({
    engine,
    manifestUrl: MANIFEST_URL,
    fetchImpl: createMockFetch({}),
  });
  await assert.rejects(() => missing.loadManifest(), /HTTP 404/);
});
