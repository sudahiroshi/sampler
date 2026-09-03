/**
 * 設定値の永続化層。
 *
 * localStorage が使えない環境（Safari のプライベートブラウズや、
 * ストレージを無効化したブラウザ）では localStorage へのアクセス自体が例外になるため、
 * 生成時に一度だけ疎通を確認し、駄目ならメモリ上のフォールバックへ切り替える。
 * これによりアプリ側は保存可否を意識せずに使える。
 */

/** localStorage が使えないときの代替。セッション中だけ値を保持する */
class MemoryStorage {
  #map = new Map();

  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }

  setItem(key, value) {
    this.#map.set(key, String(value));
  }

  removeItem(key) {
    this.#map.delete(key);
  }
}

/** localStorage が実際に読み書きできるかを確かめる。駄目なら null を返す */
function detectLocalStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probeKey = 'sampler:__probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

/** 0〜1 の範囲へ丸める。数値でない値は 0 として扱う */
function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export class SettingsStore {
  #storage;
  #prefix;
  #persistent;

  /**
   * @param {object} [options]
   * @param {Storage|null} [options.storage] 明示的に使うストレージ。null ならメモリ保持（テスト用）
   * @param {string} [options.prefix] キーの接頭辞
   */
  constructor({ storage, prefix = 'sampler:' } = {}) {
    const resolved = storage === undefined ? detectLocalStorage() : storage;
    this.#persistent = Boolean(resolved);
    this.#storage = resolved ?? new MemoryStorage();
    this.#prefix = prefix;
  }

  /** 値がブラウザに永続化されるか（false ならリロードで失われる） */
  get isPersistent() {
    return this.#persistent;
  }

  /** 音源 ID ごとの音量（0〜1）。未保存なら fallback を返す */
  getVolume(id, fallback = 1) {
    const raw = this.#read(`volume:${id}`);
    if (raw === null) return clampVolume(fallback);
    const value = Number(raw);
    if (!Number.isFinite(value)) return clampVolume(fallback);
    return clampVolume(value);
  }

  setVolume(id, volume) {
    this.#write(`volume:${id}`, String(clampVolume(volume)));
  }

  /** 起動時に全音源を読み込むか */
  getPreloadAll(fallback = false) {
    const raw = this.#read('preloadAll');
    if (raw === null) return fallback;
    return raw === 'true';
  }

  setPreloadAll(enabled) {
    this.#write('preloadAll', enabled ? 'true' : 'false');
  }

  #read(key) {
    try {
      return this.#storage.getItem(this.#prefix + key);
    } catch {
      // 読めなくても既定値で動作を継続する
      return null;
    }
  }

  #write(key, value) {
    try {
      this.#storage.setItem(this.#prefix + key, value);
    } catch {
      // 容量超過などで保存できなくてもアプリは止めない
    }
  }
}
