import { Sound } from './Sound.js';

/**
 * manifest.json をもとに音源の集合を組み立て、デコード済みバッファのキャッシュを束ねる層。
 *
 * 音源の追加は manifest.json への 1 エントリ追加だけで済み、
 * このクラスにも UI にも音源固有の知識は持たせない。
 */
export class SoundLibrary {
  #engine;
  #settings;
  #manifestUrl;
  #fetch;
  #log;
  #sounds = new Map();

  /**
   * @param {object} options
   * @param {import('./AudioEngine.js').AudioEngine} options.engine
   * @param {string} [options.manifestUrl]
   * @param {import('./SettingsStore.js').SettingsStore|null} [options.settings]
   *   音量の保存先。null なら manifest の defaultVolume をそのまま使う
   * @param {typeof fetch} [options.fetchImpl]
   * @param {import('./DebugLog.js').DebugLog} [options.log] 診断ログ
   */
  constructor({
    engine,
    manifestUrl = 'sounds/manifest.json',
    settings = null,
    fetchImpl,
    log = null,
  } = {}) {
    this.#engine = engine;
    this.#settings = settings;
    this.#manifestUrl = manifestUrl;
    this.#fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#log = log;
  }

  /** manifest を取得して Sound を組み立てる */
  async loadManifest() {
    const response = await this.#fetch(this.#manifestUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`manifest.json を取得できませんでした (HTTP ${response.status})`);
    }
    const data = await response.json();
    const entries = Array.isArray(data) ? data : data?.sounds;
    if (!Array.isArray(entries)) {
      throw new Error('manifest.json の形式が不正です（sounds 配列が必要です）');
    }

    // manifest からの相対パスで音源ファイルを解決する（例: sounds/manifest.json -> sounds/）
    const baseUrl = this.#manifestUrl.replace(/[^/]*$/, '');

    this.#sounds.clear();
    for (const entry of entries) {
      if (!entry?.id || !entry?.file) {
        throw new Error('manifest.json のエントリには id と file が必要です');
      }
      if (this.#sounds.has(entry.id)) {
        throw new Error(`manifest.json の id が重複しています: ${entry.id}`);
      }
      const defaultVolume = entry.defaultVolume ?? 1;
      const volume = this.#settings
        ? this.#settings.getVolume(entry.id, defaultVolume)
        : defaultVolume;
      this.#sounds.set(
        entry.id,
        new Sound(entry, {
          engine: this.#engine,
          baseUrl,
          volume,
          fetchImpl: this.#fetch,
          log: this.#log,
        }),
      );
    }
    return this.sounds;
  }

  /** 登録順の Sound 配列 */
  get sounds() {
    return [...this.#sounds.values()];
  }

  get size() {
    return this.#sounds.size;
  }

  get(id) {
    return this.#sounds.get(id) ?? null;
  }

  /** 音量を変更し、同時に永続化する */
  setVolume(id, volume) {
    const sound = this.get(id);
    if (!sound) return null;
    const applied = sound.setVolume(volume);
    this.#settings?.setVolume(id, applied);
    return applied;
  }

  /**
   * 全音源を並列に読み込む。失敗したものがあっても残りは読み込む。
   * @param {(done: number, total: number) => void} [onProgress]
   */
  async preloadAll(onProgress) {
    const sounds = this.sounds;
    const total = sounds.length;
    let done = 0;
    onProgress?.(done, total);

    const results = await Promise.all(
      sounds.map(async (sound) => {
        let succeeded = true;
        try {
          await sound.load();
        } catch {
          succeeded = false; // 個々の失敗は Sound 側が ERROR として保持する
        }
        done += 1;
        onProgress?.(done, total);
        return succeeded;
      }),
    );

    return { total, loaded: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
  }

  /** 鳴っている音をすべて止める */
  stopAll() {
    for (const sound of this.#sounds.values()) {
      sound.stop();
    }
  }
}
