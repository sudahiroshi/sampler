import { AudioEngine } from './AudioEngine.js';
import { SettingsStore } from './SettingsStore.js';
import { SoundLibrary } from './SoundLibrary.js';
import { SamplerUI } from './SamplerUI.js';

// 各層を組み立てるだけの配線用モジュール。ロジックは各クラス側にある。
const settings = new SettingsStore();
const engine = new AudioEngine({
  keepAliveElement: document.getElementById('silent-keepalive'),
});
const library = new SoundLibrary({
  engine,
  manifestUrl: 'sounds/manifest.json',
  settings,
});
const ui = new SamplerUI({
  library,
  settings,
  gridElement: document.getElementById('grid'),
  statusElement: document.getElementById('status'),
  preloadToggle: document.getElementById('preload-toggle'),
  stopAllButton: document.getElementById('stop-all'),
});

// 最初のユーザー操作で AudioContext を unlock する（iOS Safari / Chrome の自動再生制限対策）
const unlock = () => {
  engine.unlock().catch(() => {});
};
for (const type of ['pointerdown', 'touchend', 'keydown']) {
  document.addEventListener(type, unlock, { once: true, passive: true });
}

async function start() {
  if (!AudioEngine.isSupported) {
    ui.showFatal('このブラウザは Web Audio API に対応していないため再生できません。');
    return;
  }

  ui.init();

  try {
    await library.loadManifest();
  } catch (error) {
    ui.showFatal(`音源リストを読み込めませんでした: ${error.message}`);
    return;
  }

  ui.renderTiles();

  if (settings.getPreloadAll()) {
    await ui.preloadAll();
  } else {
    ui.setStatus('タイルをタップすると音が鳴ります。');
  }
}

start();
