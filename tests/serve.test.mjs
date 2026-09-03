// tako:run: node --test ${fileDir}/*.test.mjs
// tools/serve.mjs（開発用の静的サーバ）のテスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repoRoot, 'tools', 'serve.mjs');

/** サーバを子プロセスとして起動し、待ち受け開始まで待つ */
async function startServer() {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [serverPath, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => logs.push(chunk));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバが起動しませんでした')), 5000);
    const onData = (chunk) => {
      if (chunk.includes('静的サーバを起動しました')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });

  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      }),
  };
}

test('正しい Content-Type と Content-Length を返す', async () => {
  const server = await startServer();
  try {
    const cases = [
      ['/index.html', 'text/html; charset=utf-8'],
      ['/css/style.css', 'text/css; charset=utf-8'],
      ['/js/main.js', 'text/javascript; charset=utf-8'],
      ['/sounds/manifest.json', 'application/json; charset=utf-8'],
      ['/sounds/fanfare.wav', 'audio/wav'],
    ];
    for (const [path, expectedType] of cases) {
      const response = await fetch(server.base + path);
      const body = await response.arrayBuffer();
      const size = (await stat(join(repoRoot, path))).size;

      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), expectedType, path);
      assert.equal(Number(response.headers.get('content-length')), size, path);
      assert.equal(body.byteLength, size, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      assert.equal(response.headers.get('accept-ranges'), 'bytes', path);
    }
  } finally {
    await server.stop();
  }
});

test('/ で index.html を返す', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.base}/`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /効果音サンプラー/);
  } finally {
    await server.stop();
  }
});

test('Range リクエストに 206 で応答する', async () => {
  const server = await startServer();
  try {
    const size = (await stat(join(repoRoot, 'sounds/fanfare.wav'))).size;
    const original = await readFile(join(repoRoot, 'sounds/fanfare.wav'));

    // bytes=0-99
    const head = await fetch(`${server.base}/sounds/fanfare.wav`, {
      headers: { Range: 'bytes=0-99' },
    });
    const headBody = Buffer.from(await head.arrayBuffer());
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.equal(Number(head.headers.get('content-length')), 100);
    assert.equal(headBody.length, 100);
    assert.deepEqual(headBody, original.subarray(0, 100));

    // bytes=100- （末尾まで）
    const rest = await fetch(`${server.base}/sounds/fanfare.wav`, {
      headers: { Range: 'bytes=100-' },
    });
    const restBody = Buffer.from(await rest.arrayBuffer());
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), `bytes 100-${size - 1}/${size}`);
    assert.equal(restBody.length, size - 100);

    // bytes=-50 （末尾から 50 バイト）
    const suffix = await fetch(`${server.base}/sounds/fanfare.wav`, {
      headers: { Range: 'bytes=-50' },
    });
    const suffixBody = Buffer.from(await suffix.arrayBuffer());
    assert.equal(suffix.status, 206);
    assert.equal(suffixBody.length, 50);
    assert.deepEqual(suffixBody, original.subarray(size - 50));

    // 範囲外は 416
    const bad = await fetch(`${server.base}/sounds/fanfare.wav`, {
      headers: { Range: `bytes=${size + 10}-` },
    });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
  } finally {
    await server.stop();
  }
});

test('HEAD は本文を返さずヘッダだけ返す', async () => {
  const server = await startServer();
  try {
    const size = (await stat(join(repoRoot, 'sounds/wrong.wav'))).size;
    const response = await fetch(`${server.base}/sounds/wrong.wav`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get('content-length')), size);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  } finally {
    await server.stop();
  }
});

test('ディレクトリトラバーサルとサポート外メソッドを拒否する', async () => {
  const server = await startServer();
  try {
    for (const path of ['/../../../../etc/passwd', '/js/../../../etc/hosts', '/%2e%2e/%2e%2e/etc/passwd']) {
      const response = await fetch(server.base + path);
      assert.ok(
        response.status === 403 || response.status === 404,
        `${path} が ${response.status} を返した`,
      );
      const text = await response.text();
      assert.ok(!text.includes('root:'), `${path} で /etc/passwd の内容が漏れている`);
    }

    const post = await fetch(`${server.base}/index.html`, { method: 'POST' });
    assert.equal(post.status, 405);

    const missing = await fetch(`${server.base}/no-such-file.txt`);
    assert.equal(missing.status, 404);

    const directory = await fetch(`${server.base}/js`);
    assert.equal(directory.status, 404);
  } finally {
    await server.stop();
  }
});

test('同時に 8 本のリクエストを投げても詰まらず全部完了する', async () => {
  const server = await startServer();
  try {
    const targets = [
      '/sounds/fanfare.wav',
      '/sounds/drumroll.wav',
      '/sounds/correct.wav',
      '/sounds/wrong.wav',
      '/index.html',
      '/css/style.css',
      '/js/main.js',
      '/sounds/manifest.json',
    ];
    const expected = await Promise.all(
      targets.map(async (path) => (await stat(join(repoRoot, path))).size),
    );

    const startedAt = Date.now();
    const results = await Promise.all(
      targets.map(async (path) => {
        const response = await fetch(server.base + path);
        const body = await response.arrayBuffer();
        return { status: response.status, byteLength: body.byteLength };
      }),
    );
    const elapsed = Date.now() - startedAt;

    for (let i = 0; i < targets.length; i++) {
      assert.equal(results[i].status, 200, targets[i]);
      assert.equal(results[i].byteLength, expected[i], targets[i]);
    }
    // 並列に捌けていれば 1 秒もかからない
    assert.ok(elapsed < 5000, `並列 8 本に ${elapsed}ms かかった`);
  } finally {
    await server.stop();
  }
});

test('アクセスログにメソッド・パス・ステータス・バイト数・所要時間が出る', async () => {
  const server = await startServer();
  try {
    await (await fetch(`${server.base}/sounds/correct.wav`)).arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const output = server.logs.join('');
    assert.match(output, /GET \/sounds\/correct\.wav -> 200 149984B [\d.]+ms/);
  } finally {
    await server.stop();
  }
});
