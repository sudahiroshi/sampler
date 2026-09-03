/**
 * 画面上に出す簡易ログ。
 *
 * iOS Safari は手元でコンソールが見られないため、URL に `?debug=1` を付けたときだけ
 * AudioContext の状態遷移・発火したイベント・再生の開始/終了・エラーを画面へ表示する。
 * 通常表示では何も描画せず、log() も即 return する。
 */
export class DebugLog {
  #enabled;
  #element = null;
  #list = null;
  #entries = [];
  #max;

  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled] false なら何もしない
   * @param {number} [options.max] 保持する行数
   */
  constructor({ enabled = false, max = 80 } = {}) {
    this.#enabled = Boolean(enabled);
    this.#max = max;
  }

  /** URL の ?debug=1 で有効かどうかを判定する */
  static isEnabled(search = globalThis.location?.search ?? '') {
    try {
      return new URLSearchParams(search).get('debug') === '1';
    } catch {
      return false;
    }
  }

  get enabled() {
    return this.#enabled;
  }

  /** 記録済みの行（テストと報告用） */
  get entries() {
    return [...this.#entries];
  }

  /** 有効なときだけ画面へパネルを差し込む */
  mount(parent = globalThis.document?.body) {
    if (!this.#enabled || !parent || this.#element) return this;

    const root = parent.ownerDocument.createElement('section');
    root.className = 'debug-log';
    root.id = 'debug-log';

    const title = parent.ownerDocument.createElement('h2');
    title.className = 'debug-log__title';
    title.textContent = '診断ログ（?debug=1）';

    const list = parent.ownerDocument.createElement('ol');
    list.className = 'debug-log__list';

    root.append(title, list);
    parent.append(root);
    this.#element = root;
    this.#list = list;
    return this;
  }

  /**
   * 1 行記録する。
   * @param {string} category 'context' | 'event' | 'play' | 'error' など
   * @param {string} message
   */
  log(category, message) {
    if (!this.#enabled) return;

    const at = new Date();
    const time =
      `${String(at.getMinutes()).padStart(2, '0')}:` +
      `${String(at.getSeconds()).padStart(2, '0')}.` +
      `${String(at.getMilliseconds()).padStart(3, '0')}`;
    const entry = { time, category, message };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.shift();

    if (!this.#list) return;
    const item = this.#list.ownerDocument.createElement('li');
    item.className = `debug-log__item debug-log__item--${category}`;
    item.textContent = `${time} [${category}] ${message}`;
    this.#list.prepend(item); // 新しい行が上に来るようにする
    while (this.#list.children.length > this.#max) {
      this.#list.lastElementChild.remove();
    }
  }
}
