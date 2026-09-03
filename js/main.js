import { AudioEngine } from './AudioEngine.js';
import { SettingsStore } from './SettingsStore.js';
import { SoundLibrary } from './SoundLibrary.js';
import { SamplerUI } from './SamplerUI.js';
import { ThemeController } from './ThemeController.js';
import { DebugLog } from './DebugLog.js';
import { MediaSound } from './MediaSound.js';
import { Sound } from './Sound.js';

// 各層を組み立てるだけの配線用モジュール。ロジックは各クラス側にある。
const settings = new SettingsStore();
// ?debug=1 のときだけ画面に診断ログを出す（iOS ではコンソールが見られないため）
const log = new DebugLog({ enabled: DebugLog.isEnabled() }).mount(
  document.querySelector('.app') ?? document.body,
);

// index.html の先頭で拾っておいたエラーを取り込み、以降も記録し続ける
for (const text of globalThis.__samplerEarlyErrors ?? []) log.log('error', text);
addEventListener('error', (event) => {
  log.log('error', `${event.message || event.type} @ ${event.filename ?? '?'}:${event.lineno ?? 0}`);
});
addEventListener('unhandledrejection', (event) => {
  log.log('error', `unhandledrejection: ${event.reason?.message ?? event.reason}`);
});
// 再生経路の切り分け用。?engine=audio のときだけ HTMLAudioElement 経路にする
// （既定と ?engine=webaudio は Web Audio 経路。自動フォールバックはしない）
const useMediaElement =
  new URLSearchParams(globalThis.location?.search ?? '').get('engine') === 'audio';
const soundClass = useMediaElement ? MediaSound : Sound;

// AudioContext はこの 1 インスタンスだけを使い回す。<audio> 経路では作らない
const engine = useMediaElement ? null : new AudioEngine({ log });
// data-theme 自体は index.html の同期スクリプトが先に付けている。
// ここでは選択値の保持と、OS のテーマ変更への追従を受け持つ。
const theme = new ThemeController({ settings }).init();
const library = new SoundLibrary({
  engine,
  manifestUrl: 'sounds/manifest.json',
  settings,
  log,
  soundClass,
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
if (engine) {
  const unlock = () => {
    log.log('event', 'document の初回ジェスチャで unlock');
    engine.unlock().catch(() => {});
  };
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(type, unlock, { once: true, passive: true });
  }
}

log.setHeadline(
  `再生経路: ${useMediaElement ? 'HTMLAudioElement (Blob URL) ?engine=audio' : 'Web Audio (AudioContext)'}` +
    ` / Web Audio 対応: ${AudioEngine.isSupported ? 'あり' : 'なし'}`,
);

async function start() {
  if (!useMediaElement && !AudioEngine.isSupported) {
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
