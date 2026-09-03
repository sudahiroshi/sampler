// テスト用のモック。DOM と Web Audio に依存する部分だけを差し替える。

/** AudioEngine の代わり。呼び出し回数を数えられる */
export function createMockEngine() {
  const engine = {
    decodeCount: 0,
    unlockCount: 0,
    currentTime: 0,
    createdSources: [],
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
      engine.createdSources.push(source);
      return source;
    },
  };
  return engine;
}

/** 診断ログの代わり。記録された行を後から検査できる */
export function createLogSpy() {
  const entries = [];
  return {
    enabled: true,
    entries,
    log(category, message) {
      entries.push({ category, message });
    },
    warn(message) {
      entries.push({ category: 'warn', message });
    },
    warnings() {
      return entries.filter((entry) => entry.category === 'warn').map((entry) => entry.message);
    },
    messages(category) {
      return entries.filter((entry) => entry.category === category).map((entry) => entry.message);
    },
  };
}

/**
 * テスト用の WAV を作る。truncateTo を渡すとその長さで切り落とす（途中で切れた応答を模す）。
 */
export function buildTestWav({
  sampleRate = 44100,
  seconds = 1,
  channels = 1,
  bits = 16,
  truncateTo = null,
} = {}) {
  const frames = Math.round(sampleRate * seconds);
  const bytesPerFrame = channels * (bits / 8);
  const dataBytes = frames * bytesPerFrame;
  const total = 44 + dataBytes;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, total - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, bits, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * bytesPerFrame, ((i % 200) - 100) * 100, true);
  }

  return truncateTo === null ? buffer : buffer.slice(0, truncateTo);
}

/** Content-Length を明示できる fetch の代わり */
export function createHeaderFetch({ status = 200, contentLength, body }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-length' && contentLength !== undefined
            ? String(contentLength)
            : null,
      },
      async arrayBuffer() {
        return body;
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
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

/**
 * AudioContext の代わり。生成数・resume / suspend / close の呼び出しを数えられる。
 * iOS の 'interrupted' も再現できるよう state を外から書き換えられるようにしている。
 */
export function createFakeAudioContextClass({ initialState = 'suspended' } = {}) {
  const instances = [];

  class FakeAudioContext {
    constructor() {
      this.state = initialState;
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.destination = { name: 'destination' };
      this.resumeCalls = 0;
      this.suspendCalls = 0;
      this.closeCalls = 0;
      this.createdSources = [];
      this.listeners = [];
      instances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.push([type, listener]);
    }

    emitStateChange() {
      for (const [type, listener] of this.listeners) {
        if (type === 'statechange') listener({ type });
      }
    }

    createBuffer(channels, length) {
      return { numberOfChannels: channels, length };
    }

    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        startCount: 0,
        stopCount: 0,
        disconnectCount: 0,
        connect() {},
        disconnect() {
          source.disconnectCount += 1;
        },
        start() {
          source.startCount += 1;
        },
        stop() {
          source.stopCount += 1;
        },
      };
      this.createdSources.push(source);
      return source;
    }

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
    }

    async resume() {
      this.resumeCalls += 1;
      this.state = 'running';
      this.emitStateChange();
    }

    async suspend() {
      this.suspendCalls += 1;
      this.state = 'suspended';
      this.emitStateChange();
    }

    async close() {
      this.closeCalls += 1;
      this.state = 'closed';
      this.emitStateChange();
    }

    decodeAudioData(arrayBuffer, onSuccess) {
      onSuccess({ byteLength: arrayBuffer.byteLength, duration: 1 });
    }
  }

  return { FakeAudioContext, instances };
}

/**
 * SamplerUI を Node 上で動かすための最小の document。
 * 生成した要素は fire(type) で登録済みリスナーを直接呼べる。
 */
export function createFakeDocument() {
  const createElement = (tag) => {
    const element = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      attributes: {},
      listeners: new Map(),
      textContent: '',
      className: '',
      value: '',
      checked: false,
      classList: {
        names: new Set(),
        add(name) {
          this.names.add(name);
        },
        remove(name) {
          this.names.delete(name);
        },
        toggle(name, on) {
          if (on) this.names.add(name);
          else this.names.delete(name);
        },
        contains(name) {
          return this.names.has(name);
        },
      },
      append(...nodes) {
        element.children.push(...nodes);
      },
      setAttribute(name, value) {
        element.attributes[name] = String(value);
      },
      getAttribute(name) {
        return element.attributes[name] ?? null;
      },
      addEventListener(type, listener) {
        if (!element.listeners.has(type)) element.listeners.set(type, []);
        element.listeners.get(type).push(listener);
      },
      /** 登録済みリスナーを呼ぶ（イベント発火の代わり） */
      fire(type) {
        for (const listener of element.listeners.get(type) ?? []) listener({ type });
      },
    };
    return element;
  };
  return { createElement };
}

/** マイクロタスクとタイマーを消化する */
export function settle(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
