/**
 * 音源 1 つ分の読み込みと再生を担うクラス。
 *
 * DOM に一切触れないため、UI を差し替えてもこのクラスはそのまま再利用できる。
 * fetch した ArrayBuffer をデコードした AudioBuffer は自身が保持し、
 * 2 回目以降の再生ではネットワークアクセスもデコードも発生しない。
 */

/** 音源の状態。UI はこれを見て表示を切り替える */
export const SoundState = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  PLAYING: 'playing',
  ERROR: 'error',
});

/** 停止時のフェードアウト長（秒）。急に切るとプチノイズが出る */
const STOP_FADE_SEC = 0.02;

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export class Sound {
  #definition;
  #engine;
  #fetch;
  #url;

  #buffer = null;
  #loadPromise = null;
  #state = SoundState.IDLE;
  #error = null;

  #volume;
  #active = null;
  #listeners = new Set();

  /**
   * @param {{id: string, name: string, icon?: string, file: string, defaultVolume?: number}} definition
   *   manifest.json の 1 エントリ
   * @param {object} options
   * @param {import('./AudioEngine.js').AudioEngine} options.engine
   * @param {string} [options.baseUrl] file を解決する基準（例: "sounds/"）
   * @param {number} [options.volume] 初期音量。省略時は defaultVolume
   * @param {typeof fetch} [options.fetchImpl] テストから差し替えるための fetch
   */
  constructor(definition, { engine, baseUrl = '', volume, fetchImpl } = {}) {
    if (!definition?.id || !definition?.file) {
      throw new Error('音源定義には id と file が必要です');
    }
    this.#definition = definition;
    this.#engine = engine;
    this.#fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    const base = baseUrl.replace(/\/+$/, '');
    this.#url = base ? `${base}/${definition.file}` : definition.file;
    this.#volume = clampVolume(volume ?? definition.defaultVolume ?? 1);
  }

  get id() {
    return this.#definition.id;
  }

  get name() {
    return this.#definition.name ?? this.#definition.id;
  }

  get icon() {
    return this.#definition.icon ?? '🔊';
  }

  get url() {
    return this.#url;
  }

  get state() {
    return this.#state;
  }

  get error() {
    return this.#error;
  }

  get isLoaded() {
    return this.#buffer !== null;
  }

  get isPlaying() {
    return this.#active !== null;
  }

  get volume() {
    return this.#volume;
  }

  /** 音量を変更する。再生中なら即座に反映される */
  setVolume(volume) {
    this.#volume = clampVolume(volume);
    if (this.#active) {
      this.#active.gain.gain.value = this.#volume;
    }
    this.#emit();
    return this.#volume;
  }

  /** 状態変化の購読。戻り値を呼ぶと解除される */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 音源を取得してデコードする。
   * 成功した結果は保持され、以降の呼び出しでは再取得しない（AudioBuffer キャッシュ）。
   * 失敗した場合は記憶しないので、もう一度呼べば再試行できる。
   */
  load() {
    if (this.#loadPromise) return this.#loadPromise;

    this.#setState(SoundState.LOADING);
    const promise = (async () => {
      const response = await this.#fetch(this.#url);
      if (!response.ok) {
        throw new Error(`音源を取得できませんでした (HTTP ${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.#engine.decode(arrayBuffer);
      this.#buffer = audioBuffer;
      return audioBuffer;
    })();
    this.#loadPromise = promise;

    promise.then(
      () => {
        this.#error = null;
        this.#setState(SoundState.READY);
      },
      (error) => {
        this.#loadPromise = null; // 失敗は覚えず、次のタップで再試行できるようにする
        this.#error = error;
        this.#setState(SoundState.ERROR);
      },
    );

    return promise;
  }

  /** 未読み込みなら読み込んでから再生する。既に鳴っていれば鳴らし直す */
  async play() {
    await this.load();
    await this.#engine.unlock();

    this.stop();

    const source = this.#engine.createBufferSource();
    source.buffer = this.#buffer;
    const gain = this.#engine.createGain();
    gain.gain.value = this.#volume;
    source.connect(gain);
    gain.connect(this.#engine.destination);

    const active = { source, gain };
    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // 既に切断済みでも問題ない
      }
      // stop() で差し替わっている場合は状態を触らない
      if (this.#active === active) {
        this.#active = null;
        this.#setState(SoundState.READY);
      }
    };

    this.#active = active;
    source.start();
    this.#setState(SoundState.PLAYING);
  }

  /** 再生中なら止める。鳴っていなければ何もしない */
  stop() {
    const active = this.#active;
    if (!active) return;
    this.#active = null;

    const now = this.#engine.currentTime;
    try {
      const gainParam = active.gain.gain;
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);
      gainParam.linearRampToValueAtTime(0, now + STOP_FADE_SEC);
    } catch {
      // ランプを組めなくても停止自体は行う
    }
    try {
      active.source.stop(now + STOP_FADE_SEC);
    } catch {
      // 既に停止済みの場合は例外になるが無視してよい
    }

    if (this.#state === SoundState.PLAYING) {
      this.#setState(this.isLoaded ? SoundState.READY : SoundState.IDLE);
    }
  }

  #setState(state) {
    this.#state = state;
    this.#emit();
  }

  #emit() {
    for (const listener of this.#listeners) {
      listener(this);
    }
  }
}
