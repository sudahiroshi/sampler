#!/usr/bin/env node
// tako:run: node ${file}
// tako:cwd: ..
//
// 効果音 WAV 生成スクリプト。
// 権利的に安全な素材を手元で用意するため、Node.js 標準モジュールのみで
// 44.1kHz / 16bit / モノラルの WAV を合成して sounds/ 配下へ書き出す。
// 外部から音源をダウンロードすることはない。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
// 正規化後のピーク。1.0 に張り付かせず余裕を持たせてクリッピングを避ける
const PEAK = 0.89;
// 先頭・末尾のフェード長（秒）。再生開始/終了時のプチノイズ対策
const FADE_IN = 0.005;
const FADE_OUT = 0.02;

// ---------------------------------------------------------------------------
// 基盤クラス / ユーティリティ
// ---------------------------------------------------------------------------

/** モノラルの浮動小数点音声バッファ。各種音源を加算合成していく器 */
class AudioTrack {
  constructor(durationSec, sampleRate = SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.samples = new Float32Array(Math.round(durationSec * sampleRate));
  }

  get durationSec() {
    return this.samples.length / this.sampleRate;
  }

  /**
   * startSec から durationSec 秒間、fn(t) の戻り値を加算する。
   * t は区間内の経過秒。バッファ範囲外は無視される。
   */
  render(startSec, durationSec, fn) {
    const start = Math.round(startSec * this.sampleRate);
    const count = Math.round(durationSec * this.sampleRate);
    for (let i = 0; i < count; i++) {
      const index = start + i;
      if (index < 0 || index >= this.samples.length) continue;
      this.samples[index] += fn(i / this.sampleRate);
    }
  }

  /** 最大振幅が peak になるよう全体を線形スケールする */
  normalize(peak = PEAK) {
    let max = 0;
    for (const value of this.samples) {
      const abs = Math.abs(value);
      if (abs > max) max = abs;
    }
    if (max === 0) return this;
    const scale = peak / max;
    for (let i = 0; i < this.samples.length; i++) this.samples[i] *= scale;
    return this;
  }

  /** 先頭と末尾に線形フェードを掛ける */
  fade(inSec = FADE_IN, outSec = FADE_OUT) {
    const inCount = Math.min(Math.round(inSec * this.sampleRate), this.samples.length);
    const outCount = Math.min(Math.round(outSec * this.sampleRate), this.samples.length);
    for (let i = 0; i < inCount; i++) this.samples[i] *= i / inCount;
    for (let i = 0; i < outCount; i++) {
      this.samples[this.samples.length - 1 - i] *= i / outCount;
    }
    return this;
  }

  /** 16bit PCM モノラルの WAV バイト列へ変換する */
  toWav() {
    const dataBytes = this.samples.length * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16); // fmt チャンクのサイズ
    buffer.writeUInt16LE(1, 20); // フォーマット: リニア PCM
    buffer.writeUInt16LE(1, 22); // チャンネル数: モノラル
    buffer.writeUInt32LE(this.sampleRate, 24);
    buffer.writeUInt32LE(this.sampleRate * 2, 28); // バイト/秒
    buffer.writeUInt16LE(2, 32); // ブロックアライン
    buffer.writeUInt16LE(16, 34); // ビット深度
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < this.samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, this.samples[i]));
      buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    }
    return buffer;
  }
}

/** 決定論的な擬似乱数（mulberry32）。実行のたびに同じ WAV を得るため */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** 一次 IIR のローパス。noise の音色づくりに使う */
function createLowpass(cutoffHz, sampleRate = SAMPLE_RATE) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let last = 0;
  return (input) => {
    last += alpha * (input - last);
    return last;
  };
}

/** 一次 IIR のハイパス（入力からローパス成分を引く） */
function createHighpass(cutoffHz, sampleRate = SAMPLE_RATE) {
  const lowpass = createLowpass(cutoffHz, sampleRate);
  return (input) => input - lowpass(input);
}

/** 倍音を重ねた音。harmonics[i] は第 (i+1) 倍音の振幅 */
function harmonicTone(t, freq, harmonics) {
  let value = 0;
  for (let i = 0; i < harmonics.length; i++) {
    value += harmonics[i] * Math.sin(2 * Math.PI * freq * (i + 1) * t);
  }
  return value;
}

/** 丸めた矩形波。奇数倍音のみを有限個重ねてギザつきを抑える */
function squareTone(t, freq, partials = 9) {
  let value = 0;
  for (let n = 1; n <= partials; n += 2) {
    value += Math.sin(2 * Math.PI * freq * n * t) / n;
  }
  return value;
}

/** アタック / リリースを持つ包絡線 */
function envelope(t, durationSec, attackSec, releaseSec, decayTau = Infinity) {
  if (t < 0 || t > durationSec) return 0;
  const attack = attackSec > 0 ? Math.min(1, t / attackSec) : 1;
  const remain = durationSec - t;
  const release = releaseSec > 0 ? Math.min(1, remain / releaseSec) : 1;
  const decay = Number.isFinite(decayTau) ? Math.exp(-t / decayTau) : 1;
  return attack * release * decay;
}

// ---------------------------------------------------------------------------
// 各効果音の合成
// ---------------------------------------------------------------------------

/** ファンファーレ: 金管系の倍音を持つ上昇アルペジオ＋伸ばした和音 */
function buildFanfare() {
  const track = new AudioTrack(2.6);
  // 金管らしく高次倍音まで含ませる
  const brass = [1, 0.7, 0.5, 0.35, 0.22, 0.14, 0.08];

  const arpeggio = [
    { start: 0.0, freq: 392.0, duration: 0.22 }, // G4
    { start: 0.18, freq: 523.25, duration: 0.22 }, // C5
    { start: 0.36, freq: 659.25, duration: 0.22 }, // E5
    { start: 0.54, freq: 783.99, duration: 0.3 }, // G5
  ];
  for (const note of arpeggio) {
    track.render(note.start, note.duration, (t) => {
      const gain = envelope(t, note.duration, 0.012, 0.06, 1.2);
      return 0.5 * gain * harmonicTone(t, note.freq, brass);
    });
  }

  // 最後の和音（C5 / E5 / G5 / C6）。わずかなビブラートで金管らしさを出す
  const chordStart = 0.85;
  const chordDuration = 1.7;
  for (const freq of [523.25, 659.25, 783.99, 1046.5]) {
    track.render(chordStart, chordDuration, (t) => {
      const gain = envelope(t, chordDuration, 0.02, 0.5, 2.5);
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t);
      return 0.3 * gain * harmonicTone(t, freq * vibrato, brass);
    });
  }

  return track.normalize().fade();
}

/** ドラムロール: ノイズバースト連打が加速し、最後にクラッシュで締める */
function buildDrumRoll() {
  const track = new AudioTrack(5.5);
  const random = createRandom(20240601);
  const rollEnd = 4.2;
  const firstInterval = 0.115;
  const lastInterval = 0.026;

  for (let time = 0; time < rollEnd; ) {
    const progress = time / rollEnd;
    const amplitude = 0.35 + 0.45 * progress;
    // 1 打分のノイズバースト。高域を残しつつ低域の胴鳴りを足す
    const highpass = createHighpass(320);
    const lowpass = createLowpass(6500);
    track.render(time, 0.06, (t) => {
      const gain = envelope(t, 0.06, 0.001, 0.01, 0.012);
      const noise = lowpass(highpass(random()));
      const body = 0.35 * Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.02);
      return amplitude * gain * (noise + body);
    });
    time += firstInterval * Math.pow(lastInterval / firstInterval, progress);
  }

  // 締めのクラッシュ。明るいノイズを長めに減衰させる
  const crashHighpass = createHighpass(900);
  track.render(rollEnd, 1.3, (t) => {
    const gain = envelope(t, 1.3, 0.003, 0.25, 0.35);
    const noise = crashHighpass(random());
    const body = 0.5 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t / 0.08);
    return 0.9 * gain * (noise + body);
  });

  return track.normalize().fade();
}

/** 正解音: 高音→低音の 2 音チャイム（ピンポーン） */
function buildCorrect() {
  const track = new AudioTrack(1.7);
  // 純音に軽く倍音を乗せてチャイムらしい響きにする
  const chime = [1, 0.35, 0.12, 0.05];

  track.render(0, 0.5, (t) => {
    const gain = envelope(t, 0.5, 0.005, 0.05, 0.18);
    return 0.6 * gain * harmonicTone(t, 1046.5, chime); // C6
  });
  track.render(0.3, 1.35, (t) => {
    const gain = envelope(t, 1.35, 0.005, 0.2, 0.45);
    return 0.6 * gain * harmonicTone(t, 783.99, chime); // G5
  });

  return track.normalize().fade();
}

/** 不正解音: 低音ブザーの 2 連（ブッブー） */
function buildWrong() {
  const track = new AudioTrack(1.2);
  const buzzes = [
    { start: 0.0, duration: 0.36, freq: 155.56 }, // D#3
    { start: 0.48, duration: 0.62, freq: 146.83 }, // D3
  ];
  for (const buzz of buzzes) {
    track.render(buzz.start, buzz.duration, (t) => {
      const gain = envelope(t, buzz.duration, 0.008, 0.03);
      // わずかなうねりを足して機械的なブザーらしくする
      const wobble = 1 + 0.01 * Math.sin(2 * Math.PI * 22 * t);
      return 0.55 * gain * squareTone(t, buzz.freq * wobble);
    });
  }
  return track.normalize().fade();
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

const SOUNDS = [
  { file: 'fanfare.wav', label: 'ファンファーレ', build: buildFanfare },
  { file: 'drumroll.wav', label: 'ドラムロール', build: buildDrumRoll },
  { file: 'correct.wav', label: '正解音', build: buildCorrect },
  { file: 'wrong.wav', label: '不正解音', build: buildWrong },
];

const outputDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');

function report(file, label, track, wav) {
  console.log(
    `${file.padEnd(14)} ${label.padEnd(12)} ` +
      `${track.durationSec.toFixed(2)}s ${track.samples.length} samples ${wav.length} bytes`,
  );
}

for (const sound of SOUNDS) {
  const track = sound.build();
  const wav = track.toWav();
  writeFileSync(join(outputDir, sound.file), wav);
  report(sound.file, sound.label, track, wav);
}
