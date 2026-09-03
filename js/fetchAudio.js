/**
 * 音源ファイルの取得と、診断ログへの記録を担う共通処理。
 *
 * Web Audio 経路（Sound）と HTMLAudioElement 経路（MediaSound）で同じ記録が残るよう、
 * fetch の各段階と食い違いの検出をここに集約している。
 */
import { readWavInfo } from './wavInfo.js';

/** ヘッダから計算した秒数と実際の秒数の許容差（秒） */
export const DURATION_TOLERANCE_SEC = 0.05;

/**
 * 音源を取得する。取得したバイト数がヘッダの宣言と合わない場合は警告を記録する。
 * @returns {Promise<{arrayBuffer: ArrayBuffer, wav: object|null, contentType: string|null}>}
 */
export async function fetchAudioData({ id, url, fetchImpl, log }) {
  log?.log('fetch', `${id} 取得開始 ${url}`);
  const startedAt = Date.now();

  const response = await fetchImpl(url);
  const declaredLength = Number(response.headers?.get?.('content-length') ?? NaN);
  log?.log(
    'fetch',
    `${id} 応答 status=${response.status} content-length=${
      Number.isFinite(declaredLength) ? declaredLength : '(なし)'
    } ${Date.now() - startedAt}ms`,
  );
  if (!response.ok) {
    throw new Error(`音源を取得できませんでした (HTTP ${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  log?.log('fetch', `${id} 本文を受信 ${arrayBuffer.byteLength}B (${Date.now() - startedAt}ms)`);
  if (Number.isFinite(declaredLength) && declaredLength !== arrayBuffer.byteLength) {
    log?.warn(
      `${id} 受信バイト数が Content-Length と違う: 期待 ${declaredLength}B / 実際 ${arrayBuffer.byteLength}B`,
    );
  }

  // decodeAudioData は ArrayBuffer を detach するので、必ずデコードより前に読む
  const wav = readWavInfo(arrayBuffer);
  if (wav) {
    log?.log(
      'fetch',
      `${id} WAV ヘッダ ${wav.sampleRate}Hz ${wav.bitsPerSample}bit ch=${wav.channels} ` +
        `data=${wav.availableDataBytes}/${wav.declaredDataBytes}B ` +
        `想定 ${wav.declaredDuration.toFixed(3)}s`,
    );
    if (wav.truncated) {
      log?.warn(
        `${id} ファイルが途中で切れている: ヘッダは ${wav.declaredFileBytes}B ` +
          `${wav.declaredDuration.toFixed(3)}s のはずが ${wav.receivedBytes}B ` +
          `${wav.availableDuration.toFixed(3)}s しか届いていない`,
      );
    }
  }

  return {
    arrayBuffer,
    wav,
    contentType: response.headers?.get?.('content-type') ?? null,
  };
}

/** 実際に再生できる長さがヘッダの宣言と合っているかを確かめる */
export function checkDuration({ id, wav, duration, log }) {
  if (!wav || typeof duration !== 'number' || !Number.isFinite(duration)) return;
  const gap = Math.abs(duration - wav.declaredDuration);
  if (gap > DURATION_TOLERANCE_SEC) {
    log?.warn(
      `${id} 実際の秒数がヘッダと違う: 想定 ${wav.declaredDuration.toFixed(3)}s / ` +
        `実際 ${duration.toFixed(3)}s (差 ${gap.toFixed(3)}s)`,
    );
  }
}
