import { AudioEngine } from './AudioEngine.js';
import { SettingsStore } from './SettingsStore.js';
import { SoundLibrary } from './SoundLibrary.js';
import { SamplerUI } from './SamplerUI.js';
import { ThemeController } from './ThemeController.js';
import { DebugLog } from './DebugLog.js';

// 各層を組み立てるだけの配線用モジュール。ロジックは各クラス側にある。
const settings = new SettingsStore();
// ?debug=1 のときだけ画面に診断ログを出す（iOS ではコンソールが見られないため）
const log = new DebugLog({ enabled: DebugLog.isEnabled() }).mount(
  document.querySelector('.app') ?? document.body,
);
// AudioContext はこの 1 インスタンスだけを使い回す
const engine = new AudioEngine({ log });
// data-theme 自体は index.html の同期スクリプトが先に付けている。
// ここでは選択値の保持と、OS のテーマ変更への追従を受け持つ。
const theme = new ThemeController({ settings }).init();
const library = new SoundLibrary({
  engine,
  manifestUrl: 'sounds/manifest.json',
  settings,
  log,
});
const ui = new SamplerUI({
  library,
  settings,
  theme,
  gridElement: document.getElementById('grid'),
  statusElement: document.getElementById('status'),
  themeSelect: document.getElementById('theme-select'),
  preloadToggle: document.getElementById('preload-toggle'),
  stopAllButton: document.getElementById('stop-all'),
  log,
});

// 最初のユーザー操作で AudioContext を unlock する（iOS Safari / Chrome の自動再生制限対策）
const unlock = () => {
  log.log('event', 'document の初回ジェスチャで unlock');
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
