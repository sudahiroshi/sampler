import { SoundState } from './Sound.js';

/**
 * UI の描画とイベント処理を担う層。
 *
 * 再生ロジックは SoundLibrary / Sound 側にあり、このクラスは「表示」と「入力」だけを扱う。
 * そのため UI をまるごと差し替えても音の再生部分はそのまま再利用できる。
 */

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
  #grid;
  #status;
  #preloadToggle;
  #stopAllButton;
  #tiles = new Map();

  /**
   * @param {object} options
   * @param {import('./SoundLibrary.js').SoundLibrary} options.library
   * @param {import('./SettingsStore.js').SettingsStore} options.settings
   * @param {HTMLElement} options.gridElement タイルを並べる親要素
   * @param {HTMLElement} options.statusElement 進捗やエラーを出す要素
   * @param {HTMLInputElement} options.preloadToggle 「起動時に全読み込み」チェックボックス
   * @param {HTMLButtonElement} options.stopAllButton 全停止ボタン
   */
  constructor({ library, settings, gridElement, statusElement, preloadToggle, stopAllButton }) {
    this.#library = library;
    this.#settings = settings;
    this.#grid = gridElement;
    this.#status = statusElement;
    this.#preloadToggle = preloadToggle;
    this.#stopAllButton = stopAllButton;
  }

  /** ヘッダ側のコントロールを初期化して配線する */
  init() {
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
    pad.addEventListener('click', () => this.#handlePadClick(sound));

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

  async #handlePadClick(sound) {
    if (sound.isPlaying) {
      sound.stop();
      return;
    }
    try {
      await sound.play();
    } catch (error) {
      this.setStatus(`${sound.name}: ${error.message}`);
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
