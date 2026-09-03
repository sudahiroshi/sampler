/**
 * Web Audio API の薄いラッパ。
 *
 * AudioContext の生成・iOS Safari 向けの unlock 処理・デコードを引き受け、
 * 上位のクラス（Sound / SoundLibrary）がブラウザ差異を意識しないようにする。
 */
export class AudioEngine {
  #context = null;
  #unlocked = false;
  #keepAliveElement;

  /**
   * @param {object} [options]
   * @param {HTMLMediaElement|null} [options.keepAliveElement]
   *   iOS で消音スイッチの影響を受けにくくするために鳴らす無音の <audio> 要素
   */
  constructor({ keepAliveElement = null } = {}) {
    this.#keepAliveElement = keepAliveElement;
  }

  static get isSupported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  /** AudioContext を必要になった時点で生成する */
  ensureContext() {
    if (!this.#context) {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('このブラウザは Web Audio API に対応していません');
      }
      this.#context = new AudioContextClass();
    }
    return this.#context;
  }

  /** まだ生成していなければ null */
  get context() {
    return this.#context;
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
   * ユーザー操作の中から呼ぶこと。iOS / Chrome の自動再生制限を解除する。
   * 何度呼んでも安全で、バックグラウンド復帰後の suspended からの復帰にも使う。
   */
  async unlock() {
    const context = this.ensureContext();

    if (!this.#unlocked) {
      this.#unlocked = true;
      // 無音バッファを 1 度鳴らすと iOS の再生ロックが外れる
      try {
        const buffer = context.createBuffer(1, 1, context.sampleRate);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(0);
      } catch {
        // 解除に失敗しても resume 側で救えることがあるので握りつぶす
      }
      // 無音のメディア要素を再生してオーディオセッションを「再生中」にする
      if (this.#keepAliveElement) {
        try {
          this.#keepAliveElement.volume = 0;
          await this.#keepAliveElement.play();
        } catch {
          // 再生できなくても Web Audio 自体は動くので無視する
        }
      }
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        // resume できない場合はこの後の再生も鳴らないが、例外は上に投げない
      }
    }
    return context.state === 'running';
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
