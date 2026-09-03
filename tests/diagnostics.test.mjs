// tako:run: node --test ${fileDir}/*.test.mjs
// 診断ログと食い違い検出（?debug=1 で実機の原因を切り分けるための仕組み）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';

import { DebugLog } from '../js/DebugLog.js';
import { readWavInfo } from '../js/wavInfo.js';
import { Sound } from '../js/Sound.js';
import {
  buildTestWav,
  createHeaderFetch,
  createLogSpy,
  createMockEngine,
} from './helpers.mjs';

const DEFINITION = { id: 'fanfare', name: 'ファンファーレ', file: 'fanfare.wav' };

// ---------------------------------------------------------------------------
// WAV ヘッダの読み取り
// ---------------------------------------------------------------------------

test('WAV ヘッダから形式と長さを読める', () => {
  const info = readWavInfo(buildTestWav({ seconds: 2.5 }));
  assert.equal(info.format, 1);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.truncated, false);
  assert.ok(Math.abs(info.declaredDuration - 2.5) < 0.001);
  assert.equal(info.declaredDataBytes, info.availableDataBytes);
});

test('途中で切れた WAV は truncated として判定される', () => {
  const full = readWavInfo(buildTestWav({ seconds: 2 }));
  const cut = readWavInfo(buildTestWav({ seconds: 2, truncateTo: 44 + 44100 }));
  assert.equal(full.truncated, false);
  assert.equal(cut.truncated, true);
  assert.equal(cut.declaredDataBytes, full.declaredDataBytes);
  assert.equal(cut.availableDataBytes, 44100);
  assert.ok(Math.abs(cut.availableDuration - 0.5) < 0.001);
});

test('WAV でないものは null を返す', () => {
  assert.equal(readWavInfo(new ArrayBuffer(4)), null);
  assert.equal(readWavInfo(new ArrayBuffer(64)), null);
  assert.equal(readWavInfo(null), null);
});

// ---------------------------------------------------------------------------
// 食い違いの警告（受け入れ基準 20）
// ---------------------------------------------------------------------------

/** 指定の応答とデコード結果で load() を走らせ、記録された行を返す */
async function loadWith({ body, contentLength, decoded }) {
  const engine = createMockEngine();
  engine.decode = async () => decoded;
  const log = createLogSpy();
  const fetchImpl = createHeaderFetch({ contentLength, body });
  const sound = new Sound(DEFINITION, { engine, baseUrl: 'sounds/', fetchImpl, log });
  await sound.load();
  return { log, sound, engine };
}

test('Content-Length と実バイト数が食い違うと警告が出る', async () => {
  const body = buildTestWav({ seconds: 2.6 });
  const { log } = await loadWith({
    body,
    contentLength: body.byteLength + 1000, // 期待より少なく届いた状況
    decoded: { duration: 2.6, sampleRate: 44100 },
  });

  const warnings = log.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /受信バイト数が Content-Length と違う/);
  assert.match(warnings[0], new RegExp(`期待 ${body.byteLength + 1000}B`));
  assert.match(warnings[0], new RegExp(`実際 ${body.byteLength}B`));
});

test('ファイルが途中で切れていると警告が出る', async () => {
  const truncated = buildTestWav({ seconds: 2.6, truncateTo: 50000 });
  const { log } = await loadWith({
    body: truncated,
    contentLength: 50000, // 応答としては筋が通っているが中身が足りない
    decoded: { duration: 1.133, sampleRate: 44100 },
  });

  const warnings = log.warnings();
  assert.ok(
    warnings.some((text) => /ファイルが途中で切れている/.test(text)),
    warnings.join(' / '),
  );
  assert.ok(warnings.some((text) => /2\.600s のはずが/.test(text)));
});

test('デコード後の秒数がヘッダと違うと警告が出る', async () => {
  const body = buildTestWav({ seconds: 2.6 });
  const { log } = await loadWith({
    body,
    contentLength: body.byteLength,
    decoded: { duration: 0.4, sampleRate: 44100 }, // ヘッダは 2.6s なのに 0.4s しかない
  });

  const warnings = log.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /実際の秒数がヘッダと違う/);
  assert.match(warnings[0], /想定 2\.600s/);
  assert.match(warnings[0], /実際 0\.400s/);
});

test('正常なときは警告が出ず、各段階が記録される', async () => {
  const body = buildTestWav({ seconds: 2.6 });
  const { log } = await loadWith({
    body,
    contentLength: body.byteLength,
    decoded: { duration: 2.6, sampleRate: 44100 },
  });

  assert.deepEqual(log.warnings(), []);
  const fetchLines = log.messages('fetch');
  assert.ok(fetchLines.some((line) => /取得開始 sounds\/fanfare\.wav/.test(line)));
  assert.ok(fetchLines.some((line) => /応答 status=200 content-length=/.test(line)));
  assert.ok(fetchLines.some((line) => new RegExp(`本文を受信 ${body.byteLength}B`).test(line)));
  assert.ok(fetchLines.some((line) => /WAV ヘッダ 44100Hz 16bit ch=1/.test(line)));
  assert.ok(fetchLines.some((line) => /デコード完了 2\.600s 44100Hz/.test(line)));
});

test('再生が buffer の長さより明らかに早く終わると警告が出る', async () => {
  const body = buildTestWav({ seconds: 2.6 });
  const engine = createMockEngine();
  engine.decode = async () => ({ duration: 2.6, sampleRate: 44100 });
  const log = createLogSpy();
  const sound = new Sound(DEFINITION, {
    engine,
    baseUrl: 'sounds/',
    fetchImpl: createHeaderFetch({ contentLength: body.byteLength, body }),
    log,
  });

  await sound.play();
  // 2.6 秒の音が始まった直後に終わった = 中断された状況
  engine.createdSources.at(-1).onended();

  const warnings = log.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /再生が早く終わった/);
  assert.match(warnings[0], /2\.600s のはずが/);
  assert.match(warnings[0], /中断の疑い/);
  assert.ok(log.messages('play').some((line) => /再生終了 経過 /.test(line)));
});

test('ユーザーが止めた場合は「早く終わった」警告を出さない', async () => {
  const body = buildTestWav({ seconds: 2.6 });
  const engine = createMockEngine();
  engine.decode = async () => ({ duration: 2.6, sampleRate: 44100 });
  const log = createLogSpy();
  const sound = new Sound(DEFINITION, {
    engine,
    baseUrl: 'sounds/',
    fetchImpl: createHeaderFetch({ contentLength: body.byteLength, body }),
    log,
  });

  await sound.play();
  sound.stop();
  engine.createdSources.at(-1).onended();

  assert.deepEqual(log.warnings(), []);
});

test('最後まで鳴った場合は警告を出さない', async () => {
  const body = buildTestWav({ seconds: 0.2 });
  const engine = createMockEngine();
  engine.decode = async () => ({ duration: 0.2, sampleRate: 44100 });
  const log = createLogSpy();
  const sound = new Sound(DEFINITION, {
    engine,
    baseUrl: 'sounds/',
    fetchImpl: createHeaderFetch({ contentLength: body.byteLength, body }),
    log,
  });

  await sound.play();
  await new Promise((resolve) => setTimeout(resolve, 250));
  engine.createdSources.at(-1).onended();

  assert.deepEqual(log.warnings(), []);
});

// ---------------------------------------------------------------------------
// DebugLog 本体
// ---------------------------------------------------------------------------

test('いまは既定で有効（クエリなしでも表示する）', () => {
  assert.equal(DebugLog.enabledByDefault, true);
  assert.equal(DebugLog.isEnabled(''), true);
  assert.equal(DebugLog.isEnabled('?engine=audio'), true);
  assert.equal(DebugLog.isEnabled('?other=1'), true);
});

test('?debug=0 系で明示的に無効化できる', () => {
  for (const search of ['?debug=0', '?debug=off', '?debug=false', '?debug=no', '?debug=OFF']) {
    assert.equal(DebugLog.isEnabled(search), false, search);
  }
  assert.equal(DebugLog.isEnabled('?engine=audio&debug=0'), false);
});

test('?debug=1 系の従来の指定も引き続き有効', () => {
  for (const search of ['?debug=1', '?debug=on', '?debug=true', '?debug=yes']) {
    assert.equal(DebugLog.isEnabled(search), true, search);
  }
  assert.equal(DebugLog.isEnabled('?debug=1&engine=audio'), true);
});

test('知らない値や壊れたクエリは既定に従う', () => {
  assert.equal(DebugLog.isEnabled('?debug=maybe'), DebugLog.enabledByDefault);
  assert.equal(DebugLog.isEnabled('?debug='), DebugLog.enabledByDefault);
  assert.equal(DebugLog.isEnabled('%'), DebugLog.enabledByDefault);
});

test('折りたたみ状態を切り替えられる（DOM が無くても落ちない）', () => {
  const log = new DebugLog({ enabled: true });
  assert.equal(log.collapsed, false);
  assert.equal(log.toggleCollapsed(), true);
  assert.equal(log.collapsed, true);
  assert.equal(log.toggleCollapsed(), false);
  assert.equal(log.toggleCollapsed(true), true);
  assert.equal(log.toggleCollapsed(true), true);
});

test('無効なときは 1 行も記録しない', () => {
  const log = new DebugLog({ enabled: false });
  log.log('context', 'あ');
  log.warn('い');
  assert.deepEqual(log.entries, []);
});

test('warn は目印を付けて記録される', () => {
  const log = new DebugLog({ enabled: true });
  log.warn('食い違い');
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].category, 'warn');
  assert.match(log.entries[0].message, /⚠ 食い違い/);
});

test('保持する行数には上限がある', () => {
  const log = new DebugLog({ enabled: true, max: 5 });
  for (let i = 0; i < 20; i++) log.log('info', `行 ${i}`);
  assert.equal(log.entries.length, 5);
  assert.match(log.entries.at(-1).message, /行 19/);
});

test('toText には先頭行と UA と全行が入る', () => {
  const log = new DebugLog({ enabled: true });
  log.setHeadline('再生経路: Web Audio (AudioContext)');
  log.log('context', 'AudioContext を生成 (1 個目) state=running');
  log.warn('再生が早く終わった');

  const text = log.toText();
  assert.match(text, /=== 効果音サンプラー 診断ログ ===/);
  assert.match(text, /再生経路: Web Audio \(AudioContext\)/);
  assert.match(text, /^UA: /m);
  assert.match(text, /\[context\] AudioContext を生成 \(1 個目\) state=running/);
  assert.match(text, /\[warn\] ⚠ 再生が早く終わった/);
});

test('クリップボードが使えるときはそれでコピーする', async () => {
  const original = globalThis.navigator;
  let copied = null;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'test-ua', clipboard: { writeText: async (text) => { copied = text; } } },
  });
  try {
    const log = new DebugLog({ enabled: true });
    log.log('info', 'あ');
    assert.equal(await log.copy(), true);
    assert.match(copied, /\[info\] あ/);
    assert.match(copied, /UA: test-ua/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
    else delete globalThis.navigator;
  }
});
