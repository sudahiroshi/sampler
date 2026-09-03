// テスト用のモック。DOM と Web Audio に依存する部分だけを差し替える。

/** AudioEngine の代わり。呼び出し回数を数えられる */
export function createMockEngine() {
  const engine = {
    decodeCount: 0,
    unlockCount: 0,
    currentTime: 0,
    destination: { name: 'destination' },
    async unlock() {
      engine.unlockCount += 1;
      return true;
    },
    async decode(arrayBuffer) {
      engine.decodeCount += 1;
      return { byteLength: arrayBuffer.byteLength, duration: 1 };
    },
    createGain() {
      return {
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        startCount: 0,
        stopCount: 0,
        connect() {},
        disconnect() {},
        start() {
          source.startCount += 1;
        },
        stop() {
          source.stopCount += 1;
        },
      };
      return source;
    },
  };
  return engine;
}

/**
 * fetch の代わり。routes は URL をキーに { json } か { bytes } を持つ。
 * 未登録の URL は 404 を返す。
 */
export function createMockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return {
        ok: false,
        status: 404,
        async json() {
          throw new Error('not found');
        },
        async arrayBuffer() {
          throw new Error('not found');
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return route.json;
      },
      async arrayBuffer() {
        return new ArrayBuffer(route.bytes ?? 16);
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** localStorage 相当の最小実装（テスト内でリロードを模すために使う） */
export function createFakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
