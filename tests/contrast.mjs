#!/usr/bin/env node
// tako:run: node ${file}
// tako:cwd: ..
//
// css/style.css のテーマトークンを読み、主要な前景/背景ペアのコントラスト比を
// WCAG の相対輝度式で実測する。本文とタイルのラベルは 4.5:1 以上を要求する。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'css', 'style.css');
const css = readFileSync(cssPath, 'utf8');

/** セレクタに対応するブロックから --token: value を抜き出す */
function extractTokens(selector) {
  const index = css.indexOf(selector);
  if (index === -1) throw new Error(`セレクタが見つかりません: ${selector}`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const tokens = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (match) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function parseHex(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 2.x の相対輝度 */
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

// [前景トークン, 背景トークン, 説明, 必要比]
// 4.5 は本文相当のテキスト、3.0 は枠線や面などの非テキスト要素の判別可否
const PAIRS = [
  ['--text', '--bg', '見出し・本文', 4.5],
  ['--text', '--panel', 'タイルのラベル', 4.5],
  ['--muted', '--bg', 'ステータス行・フッター', 4.5],
  ['--muted', '--panel', 'タイルの状態表示', 4.5],
  ['--muted', '--playing-surface', '再生中タイルの音量%表示', 4.5],
  ['--playing', '--playing-surface', '再生中タイルの状態文字', 4.5],
  ['--error', '--panel', 'エラー時の状態文字', 4.5],
  ['--accent', '--panel', '読み込み中の状態文字', 4.5],
  ['--text', '--panel-active', '押下中のタイルのラベル', 4.5],
  // 「再生中」の判別は枠線（3:1 以上）と緑の状態文字で担保する。
  // 面の着色はその補助なので、知覚できる差があれば十分とする。
  ['--playing', '--bg', '再生中タイルの枠線', 3.0],
  ['--playing-surface', '--panel', '再生中タイルの面（枠線の補助）', 1.15],
  ['--border', '--bg', 'タイルの枠線', 1.2],
];

const THEMES = [
  ['ライト', ":root,\nhtml[data-theme='light']"],
  ['ダーク', "html[data-theme='dark']"],
];

let failed = 0;
for (const [label, selector] of THEMES) {
  const tokens = extractTokens(selector);
  console.log(`\n[${label}テーマ]`);
  for (const [fg, bg, description, required] of PAIRS) {
    const ratio = contrast(tokens[fg], tokens[bg]);
    const ok = ratio >= required;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'OK ' : 'NG '} ${ratio.toFixed(2).padStart(5)}:1 ` +
        `(必要 ${required.toFixed(2)}) ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} — ${description}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} 件がコントラスト基準を満たしていません`);
  process.exit(1);
}
console.log('\nすべてのペアが基準を満たしています');
