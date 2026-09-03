/**
 * テーマ（配色）の決定と適用を担うクラス。
 *
 * 選択値の保存は SettingsStore に任せ、ここでは
 * 「選択値 + OS 設定 → 実際に適用するテーマ」の解決と、
 * ルート要素への `data-theme` 付与だけを行う。
 */

/** テーマの選択肢 */
export const ThemeMode = Object.freeze({
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
});

/** 実際に適用されるテーマ */
export const ResolvedTheme = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
});

const DARK_QUERY = '(prefers-color-scheme: dark)';

export class ThemeController {
  #settings;
  #root;
  #media;
  #mode;
  #listeners = new Set();

  /**
   * @param {object} options
   * @param {import('./SettingsStore.js').SettingsStore} options.settings
   * @param {{dataset: object}} [options.root] `data-theme` を付ける要素
   * @param {MediaQueryList} [options.media] テスト時に差し替えるための matchMedia の結果
   */
  constructor({ settings, root = globalThis.document?.documentElement, media } = {}) {
    this.#settings = settings;
    this.#root = root ?? null;
    this.#media = media ?? globalThis.matchMedia?.(DARK_QUERY) ?? null;
    this.#mode = ThemeController.normalize(settings.getTheme(ThemeMode.SYSTEM));
  }

  /** 未知の値や壊れた保存値はシステム設定に従う扱いにする */
  static normalize(value) {
    return value === ThemeMode.LIGHT || value === ThemeMode.DARK ? value : ThemeMode.SYSTEM;
  }

  /** 保存済みの選択を適用し、OS 側のテーマ変更の購読を始める */
  init() {
    this.#apply();
    // 「システム設定に従う」のときだけ、実行中の OS のテーマ変更へ追従する
    this.#media?.addEventListener?.('change', () => {
      if (this.#mode === ThemeMode.SYSTEM) this.#apply();
    });
    return this;
  }

  /** 選択値（system / light / dark） */
  get mode() {
    return this.#mode;
  }

  /** 実際に適用されるテーマ（light / dark） */
  get resolvedTheme() {
    if (this.#mode !== ThemeMode.SYSTEM) return this.#mode;
    return this.#media?.matches ? ResolvedTheme.DARK : ResolvedTheme.LIGHT;
  }

  /** 選択を変更して保存し、即座に適用する */
  setMode(mode) {
    this.#mode = ThemeController.normalize(mode);
    this.#settings.setTheme(this.#mode);
    this.#apply();
    return this.#mode;
  }

  /** テーマが変わったときの通知。戻り値を呼ぶと解除される */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #apply() {
    if (this.#root) {
      this.#root.dataset.theme = this.resolvedTheme;
    }
    for (const listener of this.#listeners) {
      listener(this);
    }
  }
}
