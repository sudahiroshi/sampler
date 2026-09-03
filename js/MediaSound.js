/**
 * 音源 1 つ分の読み込みと再生を、HTMLAudioElement（Blob URL 経由）で行うクラス。
 *
 * Sound（Web Audio 経路）と同じインターフェースを実装しているので、
 * SoundLibrary へ差し替えるだけで再生経路を切り替えられる。UI 側の分岐は不要。
 *
 * 用途は切り分け（`?engine=audio`）で、自動フォールバックには使わない。
 */
import { SoundState } from './Sound.js';
import { checkDuration, fetchAudioData } from './fetchAudio.js';

/** 再生が早く終わったと判断する差（秒）。これ以上早いと中断を疑う */
const EARLY_END_TOLERANCE_SEC = 0.15;

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

export class MediaSound {
  #definition;
  #fetch;
  #url;
  #log;

  #element = null;
  #objectUrl = null;
  #loadPromise = null;
  #state = SoundState.IDLE;
  #error = null;

  #volume;
  #playing = false;
  #startedAt = 0;
  #stoppedByUser = false;
  #listeners = new Set();

  /**
   * @param {{id: string, name: string, icon?: string, file: string, defaultVolume?: number}} definition
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {number} [options.volume]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {import('./DebugLog.js').DebugLog} [options.log]
   */
  constructor(definition, { baseUrl = '', volume, fetchImpl, log = null } = {}) {
    if (!definition?.id || !definition?.file) {
      throw new Error('音源定義には id と file が必要です');
    }
    this.#definition = definition;
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
    return this.#element !== null;
  }

  get isPlaying() {
    return this.#playing;
  }

  get volume() {
    return this.#volume;
  }

  /** 保持している要素数。Sound とインターフェースを揃えるためのもの */
  get heldNodeCount() {
    return this.#element ? 1 : 0;
  }

  /** 音量を変更する。再生中なら即座に反映される（iOS では OS 音量が優先され効かない） */
  setVolume(volume) {
    this.#volume = clampVolume(volume);
    if (this.#element) this.#element.volume = this.#volume;
    this.#emit();
    return this.#volume;
  }

  /** 状態変化の購読。戻り値を呼ぶと解除される */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 音源を取得して Blob URL の <audio> を用意する。
   * 成功した結果は保持され、以降の呼び出しでは再取得しない。
   */
  load() {
    if (this.#loadPromise) return this.#loadPromise;

    this.#setState(SoundState.LOADING);
    const promise = (async () => {
      const startedAt = Date.now();
      const { arrayBuffer, wav, contentType } = await fetchAudioData({
        id: this.id,
        url: this.#url,
        fetchImpl: this.#fetch,
        log: this.#log,
      });

      const blob = new Blob([arrayBuffer], { type: contentType || 'audio/wav' });
      this.#objectUrl = URL.createObjectURL(blob);

      const element = new Audio();
      element.preload = 'auto';
      element.playsInline = true;
      element.setAttribute('playsinline', '');
      element.volume = this.#volume;
      element.src = this.#objectUrl;

      await new Promise((resolve, reject) => {
        const onReady = () => {
          element.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          element.removeEventListener('loadedmetadata', onReady);
          reject(new Error('この音源はこのブラウザで再生できません'));
        };
        element.addEventListener('loadedmetadata', onReady, { once: true });
        element.addEventListener('error', onError, { once: true });
        element.load();
      });

      element.addEventListener('ended', () => this.#handleEnded());
      this.#element = element;

      this.#log?.log(
        'fetch',
        `${this.id} <audio> 準備完了 ${
          Number.isFinite(element.duration) ? element.duration.toFixed(3) : '?'
        }s (${Date.now() - startedAt}ms)`,
      );
      checkDuration({ id: this.id, wav, duration: element.duration, log: this.#log });
      return element;
    })();
    this.#loadPromise = promise;

    promise.then(
      () => {
        this.#error = null;
        this.#setState(SoundState.READY);
      },
      (error) => {
        this.#loadPromise = null; // 失敗は覚えず、次のタップで再試行できるようにする
        this.#releaseObjectUrl();
        this.#error = error;
        this.#setState(SoundState.ERROR);
      },
    );

    return promise;
  }

  /** 未読み込みなら読み込んでから再生する。既に鳴っていれば鳴らし直す */
  async play() {
    await this.load();
    this.stop();

    const element = this.#element;
    element.volume = this.#volume;
    try {
      element.currentTime = 0;
    } catch {
      // 巻き戻せない場合もそのまま再生する
    }

    this.#startedAt = Date.now();
    this.#stoppedByUser = false;
    await element.play();
    this.#playing = true;
    this.#log?.log(
      'play',
      `${this.id} 再生開始 (<audio>, 長さ=${
        Number.isFinite(element.duration) ? element.duration.toFixed(3) : '?'
      }s)`,
    );
    this.#setState(SoundState.PLAYING);
  }

  /** 再生中なら止める。鳴っていなければ何もしない */
  stop() {
    if (!this.#playing) return;
    this.#playing = false;
    this.#stoppedByUser = true;
    try {
      this.#element.pause();
      this.#element.currentTime = 0;
    } catch {
      // 停止できなくても状態は戻す
    }
    this.#log?.log('play', `${this.id} 停止`);
    if (this.#state === SoundState.PLAYING) {
      this.#setState(this.isLoaded ? SoundState.READY : SoundState.IDLE);
    }
  }

  #handleEnded() {
    const elapsed = (Date.now() - this.#startedAt) / 1000;
    const duration = Number.isFinite(this.#element?.duration) ? this.#element.duration : null;
    if (!this.#stoppedByUser) {
      this.#log?.log(
        'play',
        `${this.id} 再生終了 経過 ${elapsed.toFixed(3)}s / 長さ ${
          duration === null ? '?' : duration.toFixed(3)
        }s`,
      );
      if (duration !== null && elapsed < duration - EARLY_END_TOLERANCE_SEC) {
        this.#log?.warn(
          `${this.id} 再生が早く終わった: ${duration.toFixed(3)}s のはずが ` +
            `${elapsed.toFixed(3)}s で終了。中断の疑い`,
        );
      }
    }
    this.#playing = false;
    if (this.#state === SoundState.PLAYING) this.#setState(SoundState.READY);
  }

  #releaseObjectUrl() {
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
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
