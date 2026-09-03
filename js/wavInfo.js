/**
 * WAV のヘッダを読んで、ファイルが宣言している形式と長さを取り出す。
 *
 * 目的は診断で、「取得したバイト数がヘッダの宣言と合っているか」「デコード後の
 * 秒数がヘッダから計算した秒数と合っているか」を突き合わせるために使う。
 * decodeAudioData は渡した ArrayBuffer を detach するので、必ずデコードより前に呼ぶこと。
 */

/**
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{
 *   format: number, channels: number, sampleRate: number, bitsPerSample: number,
 *   declaredFileBytes: number, receivedBytes: number,
 *   declaredDataBytes: number, availableDataBytes: number,
 *   declaredDuration: number, availableDuration: number, truncated: boolean
 * } | null} WAV でなければ null
 */
export function readWavInfo(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 12) return null;
  const view = new DataView(arrayBuffer);
  const ascii = (offset, length) =>
    String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));

  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;

  const receivedBytes = arrayBuffer.byteLength;
  const declaredFileBytes = view.getUint32(4, true) + 8;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let declaredDataBytes = 0;
  let availableDataBytes = 0;

  let offset = 12;
  while (offset + 8 <= receivedBytes) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= receivedBytes) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      declaredDataBytes = size;
      // 途中で切れている場合、実際に読めている data は宣言より少ない
      availableDataBytes = Math.max(0, Math.min(size, receivedBytes - body));
      break;
    }
    offset = body + size + (size % 2); // チャンクは偶数境界に揃う
  }

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  const toSeconds = (bytes) => (bytesPerSecond > 0 ? bytes / bytesPerSecond : 0);

  return {
    format,
    channels,
    sampleRate,
    bitsPerSample,
    declaredFileBytes,
    receivedBytes,
    declaredDataBytes,
    availableDataBytes,
    declaredDuration: toSeconds(declaredDataBytes),
    availableDuration: toSeconds(availableDataBytes),
    truncated: declaredFileBytes > receivedBytes || availableDataBytes < declaredDataBytes,
  };
}
