/**
 * Web Audio API の薄いラッパ。
 *
 * AudioContext の生成・iOS Safari 向けの unlock 処理・デコードを引き受け、
 * 上位のクラス（Sound / SoundLibrary）がブラウザ差異を意識しないようにする。
 *
 * AudioContext はアプリ全体で 1 個だけ生成して使い回す（iOS には同時に生成できる
 * 数の上限がある）。また close() は不可逆で以後の再生ができなくなるため呼ばない。
 */

/** 再生可能な状態 */
const RUNNING = 'running';

export class AudioEngine {
  #context = null;
  #unlocked = false;
  #createdCount = 0;
  #log;

  /**
   * @param {object} [options]
   * @param {import('./DebugLog.js').DebugLog} [options.log] 診断ログ
   */
  constructor({ log = null } = {}) {
    this.#log = log;
  }

  static get isSupported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  /** AudioContext を必要になった時点で 1 個だけ生成する */
  ensureContext() {
    if (!this.#context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('このブラウザは Web Audio API に対応していません');
      }
      this.#context = new AudioContextClass();
      this.#createdCount += 1;
      this.#log?.log('context', `AudioContext を生成 (${this.#createdCount} 個目) state=${this.#context.state}`);
      // iOS では他アプリの音や着信で state が勝手に変わるため、遷移を記録しておく
      this.#context.addEventListener?.('statechange', () => {
        this.#log?.log('context', `state=${this.#context.state}`);
      });
    }
    return this.#context;
  }

  /** まだ生成していなければ null */
  get context() {
    return this.#context;
  }

  /** 生成した AudioContext の個数。1 を超えることはない */
  get createdContextCount() {
    return this.#createdCount;
  }

  get destination() {
    return this.ensureContext().destination;
  }

  get currentTime() {
    return this.ensureContext().currentTime;
  }

  get state() {
    return this.#context ? this.#context.state : 'closed';
  }

  /**
   * 停止していれば再開する。
   *
   * iOS は他アプリの音・着信・消音操作で AudioContext を suspended だけでなく
   * 非標準の 'interrupted' にも落とす。'suspended' だけを見ていると復帰できず
   * 以後ずっと無音になるため、'running' 以外はすべて resume を試す。
   */
  async resume() {
    const context = this.ensureContext();
    if (context.state !== RUNNING) {
      this.#log?.log('context', `resume を試行 (state=${context.state})`);
      try {
        await context.resume();
      } catch (error) {
        this.#log?.log('error', `resume 失敗: ${error?.message ?? error}`);
      }
      this.#log?.log('context', `resume 後 state=${context.state}`);
    }
    return context.state === RUNNING;
  }

  /**
   * ユーザー操作の中から呼ぶこと。iOS / Chrome の自動再生制限を解除する。
   * 何度呼んでも安全で、中断からの復帰にも使う。
   */
  async unlock() {
    const context = this.ensureContext();

    if (!this.#unlocked) {
      this.#unlocked = true;
      // 無音バッファを 1 度鳴らすと iOS の再生ロックが外れる。
      // メディア要素（<audio>）は再生し終わった時点で iOS のオーディオセッションが
      // 解放され、鳴っている Web Audio まで中断されるので使わない。
      try {
        const buffer = context.createBuffer(1, 1, context.sampleRate);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(0);
        this.#log?.log('context', '無音バッファで unlock');
      } catch (error) {
        // 解除に失敗しても resume 側で救えることがある
        this.#log?.log('error', `unlock 失敗: ${error?.message ?? error}`);
      }
    }

    return this.resume();
  }

  /**
   * ArrayBuffer を AudioBuffer へデコードする。
   * 古い Safari は Promise を返さずコールバック形式なので両対応にしている。
   */
  decode(arrayBuffer) {
    const context = this.ensureContext();
    return new Promise((resolve, reject) => {
      const result = context.decodeAudioData(
        arrayBuffer,
        (buffer) => resolve(buffer),
        (error) => reject(error ?? new Error('音源のデコードに失敗しました')),
      );
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      }
    });
  }

  createGain() {
    return this.ensureContext().createGain();
  }

  createBufferSource() {
    return this.ensureContext().createBufferSource();
  }
}
