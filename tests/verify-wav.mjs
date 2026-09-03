#!/usr/bin/env node
// tako:run: node ${file}
// tako:cwd: ..
//
// sounds/*.wav が有効な WAV かを実測して検証する。
// ヘッダの正当性・サンプル数・最大振幅（無音でなく、かつクリッピングしていないこと）を確認する。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const soundsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');

// manifest から検証対象を決めるので、音源を増やしてもこのファイルの修正は不要
const manifest = JSON.parse(readFileSync(join(soundsDir, 'manifest.json'), 'utf8'));

/** WAV バイト列を解析して形式とサンプル列を返す */
function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('RIFF ヘッダがない');
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAVE 識別子がない');
  if (buffer.readUInt32LE(4) !== buffer.length - 8) throw new Error('RIFF チャンクサイズが不一致');
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') throw new Error('fmt チャンクがない');
  const format = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (buffer.toString('ascii', 36, 40) !== 'data') throw new Error('data チャンクがない');
  const dataBytes = buffer.readUInt32LE(40);
  if (44 + dataBytes !== buffer.length) throw new Error('data チャンクサイズが不一致');

  const sampleCount = dataBytes / (bitsPerSample / 8) / channels;
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * channels; i++) {
    const value = buffer.readInt16LE(44 + i * 2);
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / (sampleCount * channels));
  return { format, channels, sampleRate, bitsPerSample, sampleCount, peak, rms };
}

let failed = 0;
for (const entry of manifest.sounds) {
  const path = join(soundsDir, entry.file);
  try {
    const info = parseWav(readFileSync(path));
    const problems = [];
    if (info.format !== 1) problems.push(`PCM ではない (format=${info.format})`);
    if (info.channels !== 1) problems.push(`モノラルではない (channels=${info.channels})`);
    if (info.sampleRate !== 44100) problems.push(`44100Hz ではない (${info.sampleRate})`);
    if (info.bitsPerSample !== 16) problems.push(`16bit ではない (${info.bitsPerSample})`);
    if (info.peak === 0) problems.push('無音である');
    if (info.peak >= 32767) problems.push(`クリッピングしている (peak=${info.peak})`);

    const seconds = info.sampleCount / info.sampleRate;
    const status = problems.length === 0 ? 'OK  ' : 'NG  ';
    console.log(
      `${status}${entry.file.padEnd(14)} ${info.sampleCount} samples ` +
        `(${seconds.toFixed(3)}s) ${info.sampleRate}Hz ${info.bitsPerSample}bit ` +
        `ch=${info.channels} peak=${info.peak} rms=${info.rms.toFixed(1)}`,
    );
    if (problems.length > 0) {
      failed++;
      for (const problem of problems) console.log(`      - ${problem}`);
    }
  } catch (error) {
    failed++;
    console.log(`NG  ${entry.file.padEnd(14)} ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} 件の WAV に問題があります`);
  process.exit(1);
}
console.log('\nすべての WAV が有効です');
