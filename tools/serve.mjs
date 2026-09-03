#!/usr/bin/env node
// tako:run: node ${file}
// tako:cwd: ..
//
// 開発用の静的ファイル配信サーバ（Node.js 標準モジュールのみ）。
//
// python3 -m http.server はシングルスレッドで、1 本の keep-alive 接続を
// 掴まれたまま離されないと後続のリクエストが処理されない。iOS Safari から
// 使うと音源の取得が途中で止まったり返らなくなることがあるため、
// 同時接続を捌けるこのサーバを使う。
//
//   node tools/serve.mjs [--port 8000] [--host 0.0.0.0] [--root .]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** コマンドライン引数を読む */
function parseArgs(argv) {
  const options = { port: 8000, host: '0.0.0.0', root: null };
  for (let i = 0; i < argv.length; i++) {
    const [name, inlineValue] = argv[i].split('=');
    const value = inlineValue ?? argv[i + 1];
    const consume = () => {
      if (inlineValue === undefined) i += 1;
    };
    if (name === '--port') {
      options.port = Number(value);
      consume();
    } else if (name === '--host') {
      options.host = value;
      consume();
    } else if (name === '--root') {
      options.root = value;
      consume();
    } else if (name === '--help' || name === '-h') {
      console.log('使い方: node tools/serve.mjs [--port 8000] [--host 0.0.0.0] [--root .]');
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`--port が不正です: ${options.port}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
// 既定のルートはこのスクリプトの 1 つ上（リポジトリのルート）
const root = resolve(options.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * リクエストのパスを実ファイルへ解決する。
 * `..` を含むパスがルートの外へ出る場合は null を返す（ディレクトリトラバーサル対策）。
 */
function resolvePath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = normalize(join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/**
 * Range ヘッダを解釈する。
 * 対応するのは単一レンジの `bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
 * @returns {{start: number, end: number}|'unsatisfiable'|null}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable';

  let start;
  let end;
  if (rawStart === '') {
    // 末尾から N バイト
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable';
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  let sent = 0;
  let logged = false;

  const log = (status, note = '') => {
    if (logged) return;
    logged = true;
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const time = new Date().toISOString().slice(11, 23);
    console.log(
      `${time} ${req.method} ${req.url} -> ${status} ${sent}B ${ms.toFixed(1)}ms${note}`,
    );
  };

  // 途中で切られた場合も分かるように記録する（実機の切断を見つけるため）
  res.on('close', () => {
    if (res.writableFinished) log(res.statusCode);
    else log(res.statusCode, ' (接続が途中で切れた)');
  });

  const sendText = (status, message) => {
    const body = Buffer.from(`${message}\n`, 'utf8');
    sent = body.length;
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(405, 'GET と HEAD にのみ対応しています');
    return;
  }

  const filePath = resolvePath(req.url);
  if (!filePath) {
    sendText(403, 'アクセスできません');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(404, 'ファイルがありません');
    return;
  }
  if (info.isDirectory()) {
    sendText(404, 'ディレクトリは配信しません');
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = parseRange(req.headers.range, info.size);

  if (range === 'unsatisfiable') {
    sent = 0;
    res.writeHead(416, {
      'Content-Range': `bytes */${info.size}`,
      'Content-Length': 0,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : info.size - 1;
  const length = info.size === 0 ? 0 : end - start + 1;

  const headers = {
    'Content-Type': contentType,
    'Content-Length': length,
    // 開発中に古い JS や音源を掴まれないようにする
    'Cache-Control': 'no-store',
    // iOS Safari はメディアに Range を投げることがある
    'Accept-Ranges': 'bytes',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;

  res.writeHead(range ? 206 : 200, headers);

  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on('data', (chunk) => {
    sent += chunk.length;
  });
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
});

// keep-alive の接続を掴まれたままでも他のリクエストは受け付けられるが、
// 放置された接続がいつまでも残らないようにタイムアウトを入れておく
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;
server.requestTimeout = 0;

server.listen(options.port, options.host, () => {
  const address = server.address();
  console.log(`静的サーバを起動しました: http://${options.host}:${address.port}/`);
  console.log(`  ルート: ${root}`);
  console.log('  停止するには Ctrl+C');
});
