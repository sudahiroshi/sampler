/**
 * 音源 1 つ分の読み込みと再生を担うクラス。
 *
 * DOM に一切触れないため、UI を差し替えてもこのクラスはそのまま再利用できる。
 * fetch した ArrayBuffer をデコードした AudioBuffer は自身が保持し、
 * 2 回目以降の再生ではネットワークアクセスもデコードも発生しない。
 */

import { readWavInfo } from './wavInfo.js';

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

/** ヘッダから計算した秒数とデコード後の秒数の許容差（秒） */
const DURATION_TOLERANCE_SEC = 0.05;

/** 再生が早く終わったと判断する差（秒）。これ以上早いと中断を疑う */
const EARLY_END_TOLERANCE_SEC = 0.15;

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
  // 再生中・停止処理中のノード。iOS Safari は参照が切れた再生中ノードを
  // 回収して音を途切れさせることがあるため、明示的に保持し onended で解放する。
  #playing = new Set();
  #listeners = new Set();
  #log;

  /**
   * @param {{id: string, name: string, icon?: string, file: string, defaultVolume?: number}} definition
   *   manifest.json の 1 エントリ
   * @param {object} options
   * @param {import('./AudioEngine.js').AudioEngine} options.engine
   * @param {string} [options.baseUrl] file を解決する基準（例: "sounds/"）
   * @param {number} [options.volume] 初期音量。省略時は defaultVolume
   * @param {typeof fetch} [options.fetchImpl] テストから差し替えるための fetch
   * @param {import('./DebugLog.js').DebugLog} [options.log] 診断ログ
   */
  constructor(definition, { engine, baseUrl = '', volume, fetchImpl, log = null } = {}) {
    if (!definition?.id || !definition?.file) {
      throw new Error('音源定義には id と file が必要です');
    }
    this.#definition = definition;
    this.#engine = engine;
    this.#fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    const base = baseUrl.replace(/\/+$/, '');
    this.#url = base ? `${base}/${definition.file}` : definition.file;
    this.#volume = clampVolume(volume ?? definition.defaultVolume ?? 1);
    this.#log = log;
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

  /** 参照を保持しているノード数。再生が終われば 0 に戻る（リーク検出用） */
  get heldNodeCount() {
    return this.#playing.size;
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
      this.#log?.log('fetch', `${this.id} 取得開始 ${this.#url}`);
      const startedAt = Date.now();
      const response = await this.#fetch(this.#url);
      const declaredLength = Number(response.headers?.get?.('content-length') ?? NaN);
      this.#log?.log(
        'fetch',
        `${this.id} 応答 status=${response.status} content-length=${
          Number.isFinite(declaredLength) ? declaredLength : '(なし)'
        } ${Date.now() - startedAt}ms`,
      );
      if (!response.ok) {
        throw new Error(`音源を取得できませんでした (HTTP ${response.status})`);
      }

      const arrayBuffer = await response.arrayBuffer();
      this.#log?.log(
        'fetch',
        `${this.id} 本文を受信 ${arrayBuffer.byteLength}B (${Date.now() - startedAt}ms)`,
      );
      if (Number.isFinite(declaredLength) && declaredLength !== arrayBuffer.byteLength) {
        this.#log?.warn(
          `${this.id} 受信バイト数が Content-Length と違う: 期待 ${declaredLength}B / 実際 ${arrayBuffer.byteLength}B`,
        );
      }

      // decodeAudioData は ArrayBuffer を detach するので、必ずデコードより前に読む
      const wav = readWavInfo(arrayBuffer);
      if (wav) {
        this.#log?.log(
          'fetch',
          `${this.id} WAV ヘッダ ${wav.sampleRate}Hz ${wav.bitsPerSample}bit ch=${wav.channels} ` +
            `data=${wav.availableDataBytes}/${wav.declaredDataBytes}B ` +
            `想定 ${wav.declaredDuration.toFixed(3)}s`,
        );
        if (wav.truncated) {
          this.#log?.warn(
            `${this.id} ファイルが途中で切れている: ヘッダは ${wav.declaredFileBytes}B ` +
              `${wav.declaredDuration.toFixed(3)}s のはずが ${wav.receivedBytes}B ` +
              `${wav.availableDuration.toFixed(3)}s しか届いていない`,
          );
        }
      }

      const audioBuffer = await this.#engine.decode(arrayBuffer);
      this.#log?.log(
        'fetch',
        `${this.id} デコード完了 ${audioBuffer.duration?.toFixed?.(3) ?? '?'}s ` +
          `${audioBuffer.sampleRate ?? '?'}Hz (${Date.now() - startedAt}ms)`,
      );
      if (wav && typeof audioBuffer.duration === 'number') {
        const gap = Math.abs(audioBuffer.duration - wav.declaredDuration);
        if (gap > DURATION_TOLERANCE_SEC) {
          this.#log?.warn(
            `${this.id} デコード後の秒数がヘッダと違う: 想定 ${wav.declaredDuration.toFixed(3)}s / ` +
              `実際 ${audioBuffer.duration.toFixed(3)}s (差 ${gap.toFixed(3)}s)`,
          );
        }
      }

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
    // 読み込みより先に unlock する。iOS はユーザー操作から離れるほど解除に失敗しやすい
    await this.#engine.unlock();
    await this.load();

    this.stop();

    const source = this.#engine.createBufferSource();
    source.buffer = this.#buffer;
    const gain = this.#engine.createGain();
    gain.gain.value = this.#volume;
    source.connect(gain);
    gain.connect(this.#engine.destination);

    const node = {
      source,
      gain,
      releaseTimer: null,
      startedAt: Date.now(),
      duration: typeof this.#buffer?.duration === 'number' ? this.#buffer.duration : null,
      stoppedByUser: false,
    };
    this.#playing.add(node);
    source.onended = () => this.#release(node);

    this.#active = node;
    source.start();
    this.#log?.log(
      'play',
      `${this.id} 再生開始 (state=${this.#engine.state}, ` +
        `sampleRate=${this.#engine.context?.sampleRate ?? '?'}, ` +
        `長さ=${node.duration === null ? '?' : node.duration.toFixed(3)}s, ` +
        `保持ノード=${this.#playing.size})`,
    );
    this.#setState(SoundState.PLAYING);
  }

  /**
   * 再生中なら止める。鳴っていなければ何もしない。
   * 止めるのは再生中のソースノードだけで、AudioContext の状態には触らない。
   */
  stop() {
    const node = this.#active;
    if (!node) return;
    this.#active = null;
    node.stoppedByUser = true;

    const now = this.#engine.currentTime;
    try {
      const gainParam = node.gain.gain;
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);
      gainParam.linearRampToValueAtTime(0, now + STOP_FADE_SEC);
    } catch {
      // ランプを組めなくても停止自体は行う
    }
    try {
      node.source.stop(now + STOP_FADE_SEC);
    } catch {
      // 既に停止済みの場合は例外になるが無視してよい
    }

    // フェードが終わるまでは参照を保持し続ける。onended が来ない環境でも
    // 参照が残り続けないよう、保険として解放を予約しておく。
    node.releaseTimer = setTimeout(() => this.#release(node), STOP_FADE_SEC * 1000 + 250);

    this.#log?.log('play', `${this.id} 停止`);
    if (this.#state === SoundState.PLAYING) {
      this.#setState(this.isLoaded ? SoundState.READY : SoundState.IDLE);
    }
  }

  /** ノードを切断して保持を解除する。二重に呼ばれても安全 */
  #release(node) {
    if (!this.#playing.delete(node)) return;
    if (node.releaseTimer !== null) {
      clearTimeout(node.releaseTimer);
      node.releaseTimer = null;
    }
    try {
      node.source.onended = null;
      node.source.disconnect();
      node.gain.disconnect();
    } catch {
      // 既に切断済みでも問題ない
    }
    const elapsed = (Date.now() - node.startedAt) / 1000;
    if (!node.stoppedByUser) {
      this.#log?.log(
        'play',
        `${this.id} 再生終了 経過 ${elapsed.toFixed(3)}s / 長さ ${
          node.duration === null ? '?' : node.duration.toFixed(3)
        }s (state=${this.#engine.state})`,
      );
      if (node.duration !== null && elapsed < node.duration - EARLY_END_TOLERANCE_SEC) {
        this.#log?.warn(
          `${this.id} 再生が早く終わった: ${node.duration.toFixed(3)}s のはずが ` +
            `${elapsed.toFixed(3)}s で終了 (state=${this.#engine.state})。中断の疑い`,
        );
      }
    }

    // stop() で差し替わっている場合は状態を触らない
    if (this.#active === node) {
      this.#active = null;
      this.#setState(SoundState.READY);
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
