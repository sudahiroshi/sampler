import { SoundState } from './Sound.js';

/**
 * UI の描画とイベント処理を担う層。
 *
 * 再生ロジックは SoundLibrary / Sound 側にあり、このクラスは「表示」と「入力」だけを扱う。
 * そのため UI をまるごと差し替えても音の再生部分はそのまま再利用できる。
 */

/**
 * 同じタイルの重複発火を無視する時間（ms）。
 * iOS の 1 タップは touchstart / touchend / click が続けて発火するため、
 * 何かの拍子に 2 回ハンドラが走っても「再生した直後に自分で止める」事故を防ぐ。
 */
const DUPLICATE_WINDOW_MS = 250;

/** 状態ごとにタイルへ出す文言 */
const STATE_LABELS = {
  [SoundState.IDLE]: 'タップで再生',
  [SoundState.LOADING]: '読み込み中…',
  [SoundState.READY]: 'タップで再生',
  [SoundState.PLAYING]: '再生中…',
  [SoundState.ERROR]: '読み込み失敗（タップで再試行）',
};

export class SamplerUI {
  #library;
  #settings;
  #theme;
  #themeSelect;
  #grid;
  #status;
  #preloadToggle;
  #stopAllButton;
  #tiles = new Map();
  #lastActivatedAt = new Map();
  #now;
  #log;

  /**
   * @param {object} options
   * @param {import('./SoundLibrary.js').SoundLibrary} options.library
   * @param {import('./SettingsStore.js').SettingsStore} options.settings
   * @param {import('./ThemeController.js').ThemeController} options.theme
   * @param {HTMLElement} options.gridElement タイルを並べる親要素
   * @param {HTMLElement} options.statusElement 進捗やエラーを出す要素
   * @param {HTMLSelectElement} options.themeSelect テーマ選択（3 択）
   * @param {HTMLInputElement} options.preloadToggle 「起動時に全読み込み」チェックボックス
   * @param {HTMLButtonElement} options.stopAllButton 全停止ボタン
   * @param {import('./DebugLog.js').DebugLog} [options.log] 診断ログ
   * @param {() => number} [options.now] 重複判定に使う時刻。テストから差し替える
   */
  constructor({
    library,
    settings,
    theme,
    gridElement,
    statusElement,
    themeSelect,
    preloadToggle,
    stopAllButton,
    log = null,
    now = () => Date.now(),
  }) {
    this.#library = library;
    this.#settings = settings;
    this.#theme = theme;
    this.#themeSelect = themeSelect;
    this.#grid = gridElement;
    this.#status = statusElement;
    this.#preloadToggle = preloadToggle;
    this.#stopAllButton = stopAllButton;
    this.#log = log;
    this.#now = now;
  }

  /** ヘッダ側のコントロールを初期化して配線する */
  init() {
    this.#themeSelect.value = this.#theme.mode;
    this.#themeSelect.addEventListener('change', () => {
      this.#theme.setMode(this.#themeSelect.value);
    });

    this.#preloadToggle.checked = this.#settings.getPreloadAll();
    this.#preloadToggle.addEventListener('change', () => {
      const enabled = this.#preloadToggle.checked;
      this.#settings.setPreloadAll(enabled);
      // ON にした時点で読み込んでおくと、次の起動を待たずに恩恵を受けられる
      if (enabled) {
        this.preloadAll();
      } else {
        this.setStatus('起動時の全読み込みをオフにしました。');
      }
    });

    this.#stopAllButton.addEventListener('click', () => {
      this.#log?.log('event', '全停止');
      // 止めるのは再生中のノードだけ。AudioContext は動かしたままにする
      this.#library.stopAll();
      this.setStatus('すべての音を停止しました。');
    });

    if (!this.#settings.isPersistent) {
      this.setStatus('このブラウザでは設定を保存できません（音量はこのタブ内だけ有効です）。');
    }
  }

  /** manifest から読み込んだ音源ぶんのタイルを描画する */
  renderTiles() {
    this.#tiles.clear();
    this.#grid.textContent = '';
    for (const sound of this.#library.sounds) {
      const tile = this.#createTile(sound);
      this.#tiles.set(sound.id, tile);
      this.#grid.append(tile.root);
      sound.subscribe(() => this.#updateTile(sound));
      this.#updateTile(sound);
    }
  }

  /** 全音源を読み込みつつ進捗を表示する */
  async preloadAll() {
    const result = await this.#library.preloadAll((done, total) => {
      this.setStatus(`音源を読み込み中… ${done}/${total}`);
    });
    if (result.failed > 0) {
      this.setStatus(`読み込み完了 ${result.loaded}/${result.total}（${result.failed} 件失敗）`);
    } else {
      this.setStatus(`読み込み完了 ${result.loaded}/${result.total}`);
    }
    return result;
  }

  setStatus(text) {
    this.#status.textContent = text;
  }

  /** 復帰不能なエラー（manifest が読めない等）を表示する */
  showFatal(message) {
    this.#grid.textContent = '';
    this.setStatus(message);
    this.#status.classList.add('status--error');
  }

  #createTile(sound) {
    const root = document.createElement('article');
    root.className = 'tile';
    root.dataset.soundId = sound.id;

    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'tile__pad';
    pad.setAttribute('aria-label', sound.name);

    const icon = document.createElement('span');
    icon.className = 'tile__icon';
    icon.textContent = sound.icon;
    icon.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = sound.name;

    const state = document.createElement('span');
    state.className = 'tile__state';

    pad.append(icon, name, state);
    // iOS でも 1 タップ = 1 回の発火にするため click だけを購読する。
    // 万一 2 回来ても #activate 側の重複判定で弾く。
    pad.addEventListener('click', () => this.#activate(sound, 'click'));
    if (this.#log?.enabled) {
      // 実機で何が発火しているかを見るための購読。動作には影響させない
      for (const type of ['pointerdown', 'touchstart', 'touchend']) {
        pad.addEventListener(type, () => this.#log.log('event', `${sound.id} ${type}`), {
          passive: true,
        });
      }
    }

    const volumeRow = document.createElement('div');
    volumeRow.className = 'tile__volume';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'tile__slider';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(sound.volume * 100));
    slider.id = `volume-${sound.id}`;
    slider.setAttribute('aria-label', `${sound.name} の音量`);

    const value = document.createElement('output');
    value.className = 'tile__volume-value';
    value.setAttribute('for', slider.id);
    value.textContent = `${slider.value}%`;

    slider.addEventListener('input', () => {
      this.#library.setVolume(sound.id, Number(slider.value) / 100);
    });

    volumeRow.append(slider, value);
    root.append(pad, volumeRow);

    return { root, pad, state, slider, value };
  }

  /**
   * タイルが操作されたときの入口。
   * 直近の操作から DUPLICATE_WINDOW_MS 以内の再発火は重複として無視する。
   */
  #activate(sound, eventType) {
    const at = this.#now();
    const last = this.#lastActivatedAt.get(sound.id);
    if (last !== undefined && at - last < DUPLICATE_WINDOW_MS) {
      this.#log?.log('event', `${sound.id} ${eventType} を重複として無視 (${at - last}ms)`);
      return;
    }
    this.#lastActivatedAt.set(sound.id, at);
    this.#log?.log('event', `${sound.id} ${eventType} → ${sound.isPlaying ? '停止' : '再生'}`);
    this.#toggle(sound);
  }

  async #toggle(sound) {
    if (sound.isPlaying) {
      sound.stop();
      return;
    }
    try {
      await sound.play();
    } catch (error) {
      this.setStatus(`${sound.name}: ${error.message}`);
      this.#log?.log('error', `${sound.id} ${error.message}`);
    }
  }

  #updateTile(sound) {
    const tile = this.#tiles.get(sound.id);
    if (!tile) return;

    tile.root.classList.toggle('is-playing', sound.state === SoundState.PLAYING);
    tile.root.classList.toggle('is-loading', sound.state === SoundState.LOADING);
    tile.root.classList.toggle('is-error', sound.state === SoundState.ERROR);
    tile.pad.setAttribute('aria-pressed', String(sound.state === SoundState.PLAYING));
    tile.state.textContent = STATE_LABELS[sound.state] ?? '';

    const percent = Math.round(sound.volume * 100);
    // ドラッグ中に値を書き戻して操作を邪魔しないよう、differ するときだけ更新する
    if (Number(tile.slider.value) !== percent) {
      tile.slider.value = String(percent);
    }
    tile.value.textContent = `${percent}%`;
  }
}
