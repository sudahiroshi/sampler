/**
 * 画面上に出す簡易ログ。
 *
 * iOS Safari は手元でコンソールが見られないため、AudioContext の状態遷移・
 * 発火したイベント・取得したバイト数・再生の開始/終了・警告・エラーを画面へ表示する。
 * 無効なときは何も描画せず、log() も即 return する。
 *
 * 記録した内容は「ログをコピー」ボタンでまとめて取り出せる（そのまま報告に貼れる）。
 */

/**
 * 診断ログを既定で有効にするかどうか。
 *
 * 不具合の切り分け中なので、いまは URL に何も付けなくても表示する（既定 ON）。
 * **既定 OFF に戻すときは、この定数を false にするだけでよい。** 他の場所は触らないこと。
 * どちらの設定でも、URL の指定（`?debug=1` / `?debug=0`）が既定より優先される。
 */
const ENABLED_BY_DEFAULT = true;

/** `?debug=` に指定されたとき有効にする値 */
const ENABLE_VALUES = new Set(['1', 'on', 'true', 'yes']);

/** `?debug=` に指定されたとき無効にする値 */
const DISABLE_VALUES = new Set(['0', 'off', 'false', 'no']);

export class DebugLog {
  #enabled;
  #max;
  #entries = [];
  #headline = '';
  #root = null;
  #headlineElement = null;
  #list = null;
  #status = null;
  #fallback = null;
  #toggle = null;
  #collapsed = false;

  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled] false なら何もしない
   * @param {number} [options.max] 保持する行数
   */
  constructor({ enabled = false, max = 200 } = {}) {
    this.#enabled = Boolean(enabled);
    this.#max = max;
  }

  /** 既定で有効かどうか（URL に何も指定がないときの値） */
  static get enabledByDefault() {
    return ENABLED_BY_DEFAULT;
  }

  /**
   * URL のクエリから有効・無効を決める。
   * `?debug=1`（on / true / yes）で有効、`?debug=0`（off / false / no）で無効。
   * 指定がなければ ENABLED_BY_DEFAULT に従う。
   */
  static isEnabled(search = globalThis.location?.search ?? '') {
    try {
      const raw = new URLSearchParams(search).get('debug');
      if (raw === null) return ENABLED_BY_DEFAULT;
      const value = raw.trim().toLowerCase();
      if (DISABLE_VALUES.has(value)) return false;
      if (ENABLE_VALUES.has(value)) return true;
      return ENABLED_BY_DEFAULT; // 知らない値は既定に従う
    } catch {
      return ENABLED_BY_DEFAULT;
    }
  }

  get enabled() {
    return this.#enabled;
  }

  /** 折りたたまれているか */
  get collapsed() {
    return this.#collapsed;
  }

  /** 記録済みの行（テストと報告用） */
  get entries() {
    return [...this.#entries];
  }

  /** パネル先頭に出す固定行（どの再生経路で動いているか等） */
  setHeadline(text) {
    this.#headline = text;
    if (this.#headlineElement) this.#headlineElement.textContent = text;
    return this;
  }

  /** 有効なときだけ画面へパネルを差し込む */
  mount(parent = globalThis.document?.body) {
    if (!this.#enabled || !parent || this.#root) return this;
    const doc = parent.ownerDocument;

    const root = doc.createElement('section');
    root.className = 'debug-log';
    root.id = 'debug-log';

    const header = doc.createElement('div');
    header.className = 'debug-log__header';

    // 見出しをボタンにして、タップで開閉できるようにする
    const title = doc.createElement('button');
    title.type = 'button';
    title.className = 'debug-log__title';
    title.id = 'debug-log-toggle';
    title.setAttribute('aria-expanded', 'true');
    title.setAttribute('aria-controls', 'debug-log-body');
    title.textContent = '▼ 診断ログ';
    title.addEventListener('click', () => this.toggleCollapsed());

    const copyButton = doc.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'debug-log__copy';
    copyButton.id = 'debug-log-copy';
    copyButton.textContent = 'ログをコピー';
    copyButton.addEventListener('click', () => this.copy());

    const status = doc.createElement('span');
    status.className = 'debug-log__status';
    status.id = 'debug-log-status';

    const hint = doc.createElement('span');
    hint.className = 'debug-log__hint';
    hint.textContent = 'URL に ?debug=0 を付けると非表示';

    header.append(title, copyButton, status, hint);

    const headlineElement = doc.createElement('p');
    headlineElement.className = 'debug-log__headline';
    headlineElement.id = 'debug-log-headline';
    headlineElement.textContent = this.#headline;

    // 折りたたむ対象をまとめる
    const body = doc.createElement('div');
    body.className = 'debug-log__body';
    body.id = 'debug-log-body';

    const list = doc.createElement('ol');
    list.className = 'debug-log__list';

    // クリップボードが使えない環境向けのフォールバック
    const fallback = doc.createElement('textarea');
    fallback.className = 'debug-log__fallback';
    fallback.id = 'debug-log-fallback';
    fallback.readOnly = true;
    fallback.rows = 6;
    fallback.hidden = true;

    body.append(headlineElement, list, fallback);
    root.append(header, body);
    parent.append(root);

    this.#root = root;
    this.#headlineElement = headlineElement;
    this.#list = list;
    this.#status = status;
    this.#fallback = fallback;
    this.#toggle = title;

    // mount より前に記録された行を描画する
    for (const entry of this.#entries) this.#render(entry);
    return this;
  }

  /**
   * 1 行記録する。
   * @param {'context'|'event'|'fetch'|'play'|'warn'|'error'|'info'} category
   * @param {string} message
   */
  log(category, message) {
    if (!this.#enabled) return;
    const entry = { time: this.#now(), category, message };
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.shift();
    this.#render(entry);
  }

  /** 食い違いを見つけたときの記録（コピーしたログで目立つようにする） */
  warn(message) {
    this.log('warn', `⚠ ${message}`);
  }

  /** パネルの開閉を切り替える */
  toggleCollapsed(collapsed = !this.#collapsed) {
    this.#collapsed = Boolean(collapsed);
    if (this.#root) this.#root.classList.toggle('is-collapsed', this.#collapsed);
    if (this.#toggle) {
      this.#toggle.setAttribute('aria-expanded', String(!this.#collapsed));
      this.#toggle.textContent = `${this.#collapsed ? '▶' : '▼'} 診断ログ`;
    }
    return this.#collapsed;
  }

  /** 記録内容をプレーンテキストにする */
  toText() {
    const lines = this.#entries.map((e) => `${e.time} [${e.category}] ${e.message}`);
    const header = [
      '=== 効果音サンプラー 診断ログ ===',
      this.#headline,
      `at: ${new Date().toISOString()}`,
      `UA: ${globalThis.navigator?.userAgent ?? '(不明)'}`,
      '',
    ];
    return [...header, ...lines].join('\n');
  }

  /** クリップボードへコピーする。使えなければ textarea を選択状態にする */
  async copy() {
    const text = this.toText();
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        this.#setStatus(`コピーしました（${this.#entries.length} 行）`);
        return true;
      }
    } catch {
      // 権限が無い等で失敗したらフォールバックへ回す
    }
    if (this.#fallback) {
      this.#fallback.hidden = false;
      this.#fallback.value = text;
      this.#fallback.focus();
      this.#fallback.select();
      this.#fallback.setSelectionRange?.(0, text.length); // iOS はこれがないと選択されない
      this.#setStatus('選択しました。長押しして「コピー」を選んでください');
    }
    return false;
  }

  #now() {
    const at = new Date();
    return (
      `${String(at.getMinutes()).padStart(2, '0')}:` +
      `${String(at.getSeconds()).padStart(2, '0')}.` +
      `${String(at.getMilliseconds()).padStart(3, '0')}`
    );
  }

  #setStatus(text) {
    if (this.#status) this.#status.textContent = text;
  }

  #render(entry) {
    if (!this.#list) return;
    const item = this.#list.ownerDocument.createElement('li');
    item.className = `debug-log__item debug-log__item--${entry.category}`;
    item.textContent = `${entry.time} [${entry.category}] ${entry.message}`;
    this.#list.prepend(item); // 新しい行が上に来るようにする
    while (this.#list.children.length > this.#max) {
      this.#list.lastElementChild.remove();
    }
  }
}
