// tako:run: node --test ${fileDir}/*.test.mjs
// iOS で「最初の音が途中で切れ、以後ずっと無音になる」不具合の回帰テスト
import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioEngine } from '../js/AudioEngine.js';
import { MediaSound } from '../js/MediaSound.js';
import { Sound } from '../js/Sound.js';
import { SoundLibrary } from '../js/SoundLibrary.js';
import { SettingsStore } from '../js/SettingsStore.js';
import { ThemeController } from '../js/ThemeController.js';
import { SamplerUI } from '../js/SamplerUI.js';
import {
  createFakeAudioContextClass,
  createFakeDocument,
  createFakeStorage,
  createMockFetch,
  settle,
} from './helpers.mjs';

const MANIFEST_URL = 'sounds/manifest.json';
const ENTRIES = [
  { id: 'fanfare', name: 'ファンファーレ', icon: '🎺', file: 'fanfare.wav', defaultVolume: 0.8 },
  { id: 'drumroll', name: 'ドラムロール', icon: '🥁', file: 'drumroll.wav', defaultVolume: 0.7 },
  { id: 'correct', name: '正解', icon: '⭕', file: 'correct.wav', defaultVolume: 0.85 },
  { id: 'wrong', name: '不正解', icon: '❌', file: 'wrong.wav', defaultVolume: 0.85 },
];

function manifestRoutes(entries = ENTRIES) {
  const routes = { [MANIFEST_URL]: { json: { sounds: entries } } };
  for (const entry of entries) routes[`sounds/${entry.file}`] = { bytes: 64 };
  return routes;
}

/** globalThis.AudioContext を差し替えて engine を組み立てる */
async function withFakeAudio(options, body) {
  const { FakeAudioContext, instances } = createFakeAudioContextClass(options);
  const originalAudioContext = globalThis.AudioContext;
  const originalWebkit = globalThis.webkitAudioContext;
  globalThis.AudioContext = FakeAudioContext;
  delete globalThis.webkitAudioContext;
  try {
    return await body({ instances });
  } finally {
    if (originalAudioContext) globalThis.AudioContext = originalAudioContext;
    else delete globalThis.AudioContext;
    if (originalWebkit) globalThis.webkitAudioContext = originalWebkit;
  }
}

/**
 * 実際に音を鳴らしたソースノードだけを数える。
 * unlock 時の無音バッファ（createBuffer 由来）は duration を持たないので除ける。
 */
function playbackSources(context) {
  return context.createdSources.filter((source) => source.buffer && 'duration' in source.buffer);
}

// ---------------------------------------------------------------------------
// AudioContext の扱い
// ---------------------------------------------------------------------------

test('AudioContext はアプリ全体で 1 個しか生成されない', async () => {
  await withFakeAudio({}, async ({ instances }) => {
    const engine = new AudioEngine();
    engine.ensureContext();
    engine.ensureContext();
    await engine.unlock();
    await engine.unlock();
    await engine.resume();
    engine.createGain();
    engine.createBufferSource();

    assert.equal(instances.length, 1);
    assert.equal(engine.createdContextCount, 1);
  });
});

test("iOS の非標準な 'interrupted' からも resume される", async () => {
  await withFakeAudio({ initialState: 'interrupted' }, async ({ instances }) => {
    const engine = new AudioEngine();
    const running = await engine.resume();

    assert.equal(instances[0].resumeCalls, 1);
    assert.equal(instances[0].state, 'running');
    assert.equal(running, true);
  });
});

test('停止・全停止は AudioContext の状態を変えず、close も suspend も呼ばない', async () => {
  await withFakeAudio({}, async ({ instances }) => {
    const engine = new AudioEngine();
    const library = new SoundLibrary({
      engine,
      manifestUrl: MANIFEST_URL,
      fetchImpl: createMockFetch(manifestRoutes()),
    });
    await library.loadManifest();

    for (const sound of library.sounds) await sound.play();
    assert.equal(instances[0].state, 'running');

    library.get('fanfare').stop();
    library.stopAll();

    assert.equal(instances[0].state, 'running');
    assert.equal(instances[0].closeCalls, 0);
    assert.equal(instances[0].suspendCalls, 0);

    // 停止後も続けて再生できる
    await library.get('fanfare').play();
    assert.equal(library.get('fanfare').isPlaying, true);
    assert.equal(instances[0].state, 'running');
  });
});

test('同じ音を 10 回、続けて 4 種を順番に鳴らしても再生が始まり続ける', async () => {
  await withFakeAudio({}, async ({ instances }) => {
    const engine = new AudioEngine();
    const library = new SoundLibrary({
      engine,
      manifestUrl: MANIFEST_URL,
      fetchImpl: createMockFetch(manifestRoutes()),
    });
    await library.loadManifest();
    const fanfare = library.get('fanfare');

    for (let i = 0; i < 10; i++) {
      await fanfare.play();
      assert.equal(fanfare.isPlaying, true, `${i + 1} 回目`);
      fanfare.stop();
    }
    for (const sound of library.sounds) {
      await sound.play();
      assert.equal(sound.isPlaying, true, sound.id);
    }

    // 10 回 + 4 種 = 14 回の再生が始まり、コンテキストは 1 個のまま
    assert.equal(instances.length, 1);
    assert.equal(playbackSources(instances[0]).length, 14);
    assert.equal(instances[0].state, 'running');
  });
});

test('再生中ノードは参照を保持し、終了後は解放される（リークしない）', async () => {
  await withFakeAudio({}, async ({ instances }) => {
    const engine = new AudioEngine();
    const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
    const sound = new Sound(ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

    await sound.play();
    assert.equal(sound.heldNodeCount, 1);

    // 停止直後はフェードのために保持し続ける
    sound.stop();
    assert.equal(sound.heldNodeCount, 1);

    // onended が来れば解放される
    const source = playbackSources(instances[0]).at(-1);
    source.onended();
    assert.equal(sound.heldNodeCount, 0);
    assert.equal(source.disconnectCount, 1);
  });
});

test('onended が来ない環境でも保険のタイマーで解放される', async () => {
  await withFakeAudio({}, async ({ instances }) => {
    const engine = new AudioEngine();
    const fetchImpl = createMockFetch({ 'sounds/fanfare.wav': { bytes: 64 } });
    const sound = new Sound(ENTRIES[0], { engine, baseUrl: 'sounds/', fetchImpl });

    await sound.play();
    playbackSources(instances[0]).at(-1).onended = null; // onended が呼ばれない状況を作る
    sound.stop();
    assert.equal(sound.heldNodeCount, 1);

    await settle(320);
    assert.equal(sound.heldNodeCount, 0);
  });
});

// ---------------------------------------------------------------------------
// タップの二重発火
// ---------------------------------------------------------------------------

/** SamplerUI を Node 上で組み立てる。clock を進めて時間経過を作る */
async function buildUI() {
  const fakeDocument = createFakeDocument();
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument;

  const { FakeAudioContext, instances } = createFakeAudioContextClass();
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = FakeAudioContext;

  const clock = { value: 1000 };
  const storage = createFakeStorage();
  const settings = new SettingsStore({ storage });
  const engine = new AudioEngine();
  const library = new SoundLibrary({
    engine,
    manifestUrl: MANIFEST_URL,
    settings,
    fetchImpl: createMockFetch(manifestRoutes()),
  });
  await library.loadManifest();

  const element = () => fakeDocument.createElement('div');
  const grid = element();
  const status = element();
  const themeSelect = element();
  const preloadToggle = element();
  const stopAllButton = element();
  const theme = new ThemeController({
    settings,
    root: { dataset: {} },
    media: { matches: false, addEventListener() {} },
  }).init();

  const ui = new SamplerUI({
    library,
    settings,
    theme,
    gridElement: grid,
    statusElement: status,
    themeSelect,
    preloadToggle,
    stopAllButton,
    now: () => clock.value,
  });
  ui.init();
  ui.renderTiles();

  const padOf = (id) => {
    const tile = grid.children.find((child) => child.dataset.soundId === id);
    return tile.children[0];
  };

  const restore = () => {
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
    if (originalAudioContext) globalThis.AudioContext = originalAudioContext;
    else delete globalThis.AudioContext;
  };

  return { library, grid, padOf, clock, instances, restore, stopAllButton };
}

test('1 タップで click が 2 回発火しても「再生 → 即停止」にならない', async () => {
  const { library, padOf, restore, instances } = await buildUI();
  try {
    const pad = padOf('fanfare');
    // iOS の 1 タップで続けて発火するのを模す（同一時刻）
    pad.fire('click');
    pad.fire('click');
    pad.fire('click');
    await settle();

    assert.equal(library.get('fanfare').isPlaying, true);
    // 再生用のソースノードは 1 つだけ（= 再生は 1 回だけ、停止もされていない）
    assert.equal(playbackSources(instances[0]).length, 1);
  } finally {
    restore();
  }
});

test('重複ウィンドウを過ぎた再タップは仕様どおり停止になる', async () => {
  const { library, padOf, clock, restore } = await buildUI();
  try {
    const pad = padOf('drumroll');
    pad.fire('click');
    await settle();
    assert.equal(library.get('drumroll').isPlaying, true);

    clock.value += 300; // 250ms の重複ウィンドウを超える
    pad.fire('click');
    await settle();
    assert.equal(library.get('drumroll').isPlaying, false);

    clock.value += 300;
    pad.fire('click');
    await settle();
    assert.equal(library.get('drumroll').isPlaying, true);
  } finally {
    restore();
  }
});

test('重複判定は音源ごとに独立している', async () => {
  const { library, padOf, restore } = await buildUI();
  try {
    padOf('fanfare').fire('click');
    padOf('correct').fire('click');
    padOf('wrong').fire('click');
    await settle();

    assert.deepEqual(
      library.sounds.filter((sound) => sound.isPlaying).map((sound) => sound.id),
      ['fanfare', 'correct', 'wrong'],
    );
  } finally {
    restore();
  }
});

test('全停止のあとも同じタイルをタップすれば鳴る', async () => {
  const { library, padOf, clock, stopAllButton, restore, instances } = await buildUI();
  try {
    padOf('fanfare').fire('click');
    await settle();
    stopAllButton.fire('click');
    assert.equal(library.sounds.some((sound) => sound.isPlaying), false);

    clock.value += 300;
    padOf('fanfare').fire('click');
    await settle();
    assert.equal(library.get('fanfare').isPlaying, true);
    assert.equal(instances[0].state, 'running');
    assert.equal(instances[0].closeCalls, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// 再生経路の差し替え（?engine=audio の土台）
// ---------------------------------------------------------------------------

test('MediaSound は Sound と同じインターフェースを持つ（UI を触らず差し替えられる）', () => {
  const publicNames = (klass) =>
    Object.getOwnPropertyNames(klass.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

  const missing = publicNames(Sound).filter((name) => !publicNames(MediaSound).includes(name));
  assert.deepEqual(missing, [], `MediaSound に足りないもの: ${missing.join(', ')}`);
});

test('SoundLibrary は soundClass で音源クラスを差し替えられる', async () => {
  const created = [];
  class FakeSound {
    constructor(definition, options) {
      created.push({ definition, options });
      this.id = definition.id;
      this.volume = options.volume;
    }
    setVolume(value) {
      this.volume = value;
      return value;
    }
    stop() {}
  }

  const library = new SoundLibrary({
    engine: null,
    manifestUrl: MANIFEST_URL,
    fetchImpl: createMockFetch(manifestRoutes()),
    soundClass: FakeSound,
  });
  await library.loadManifest();

  assert.equal(library.size, 4);
  assert.equal(created.length, 4);
  assert.ok(library.get('fanfare') instanceof FakeSound);
  assert.equal(created[0].options.baseUrl, 'sounds/');
  assert.equal(created[0].options.volume, 0.8);
});

test('soundClass を省略すると Web Audio 経路の Sound になる', async () => {
  await withFakeAudio({}, async () => {
    const library = new SoundLibrary({
      engine: new AudioEngine(),
      manifestUrl: MANIFEST_URL,
      fetchImpl: createMockFetch(manifestRoutes()),
    });
    await library.loadManifest();
    assert.ok(library.get('fanfare') instanceof Sound);
  });
});
