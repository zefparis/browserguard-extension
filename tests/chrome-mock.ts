/**
 * Minimal typed chrome.* mock for vitest.
 *
 * Choice: manual stubs over sinon-chrome.
 * - sinon-chrome adds a dependency and its API surface is broader than what
 *   background.ts touches (it mocks the entire chrome.* namespace).
 * - background.ts uses a tiny subset: chrome.runtime.{id,lastError,getURL,
 *   onMessage.addListener}, chrome.windows.{create,onRemoved.addListener},
 *   chrome.storage.local.{get,set}. Manual stubs for exactly these are ~60
 *   lines, fully typed, and trivial to maintain.
 * - The stubs capture callbacks and call counts so tests can assert which
 *   chrome APIs were invoked and simulate async events (window removal,
 *   message delivery).
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | CC BY-NC-SA 4.0
 */

// ─── Types for the mock event listeners ─────────────────────────────

type Listener<Args extends any[]> = (...args: Args) => any;

class MockEvent<Args extends any[]> {
  listeners: Listener<Args>[] = [];

  addListener(fn: Listener<Args>): void {
    this.listeners.push(fn);
  }

  removeListener(fn: Listener<Args>): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }

  /** Simulate an event firing — calls all registered listeners. */
  emit(...args: Args): void {
    for (const l of this.listeners) {
      l(...args);
    }
  }

  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
}

// ─── chrome.runtime ─────────────────────────────────────────────────

const runtime = {
  // NOT a real extension ID — isServiceWorkerContext checks for a string
  // and excludes 'vitest-test-extension', so the lifecycle code is skipped.
  id: 'vitest-test-extension' as string,
  lastError: undefined as chrome.runtime.LastError | undefined,
  getURL: (path: string): string => `chrome-extension://test-id/${path}`,
  onMessage: new MockEvent<[any, any, any]>(),
  // getManifest — used by sendBeacon to include extVersion in the ping
  // payload (adoption tracking for the Worker-proxied step-up rollout).
  getManifest: (): { version: string } => ({ version: '0.2.0-test' }),
};

// ─── chrome.windows ─────────────────────────────────────────────────

interface MockWindow {
  id: number;
}

const windows = {
  onRemoved: new MockEvent<[number]>(),
  create: ((opts: any, callback?: (w: MockWindow) => void) => {
    // Default no-op; tests call setupWindowsCreate() to configure
  }) as any,
  getLastFocused: ((callback?: (w: { left: number; top: number; width: number; height: number }) => void) => {
    // Default: simulate a 1920x1080 window at (0,0)
    if (callback) callback({ left: 0, top: 0, width: 1920, height: 1080 });
  }) as any,
};

// ─── chrome.storage.local ───────────────────────────────────────────

const storageData: Record<string, any> = {};

const storage = {
  local: {
    get: (keys: string[], callback: (result: Record<string, any>) => void): void => {
      const result: Record<string, any> = {};
      for (const k of keys) {
        if (k in storageData) result[k] = storageData[k];
      }
      // Simulate async callback
      setTimeout(() => callback(result), 0);
    },
    set: (items: Record<string, any>): void => {
      Object.assign(storageData, items);
    },
  },
};

// ─── Assemble global chrome ─────────────────────────────────────────

const chromeMock = {
  runtime,
  windows,
  storage,
};

// Expose on globalThis so `typeof chrome !== 'undefined'` is true in tests
(globalThis as any).chrome = chromeMock;

// ─── Test helpers ───────────────────────────────────────────────────

export function resetChromeMock(): void {
  runtime.id = 'vitest-test-extension';
  runtime.lastError = undefined;
  runtime.onMessage = new MockEvent();
  windows.onRemoved = new MockEvent();
  for (const k of Object.keys(storageData)) delete storageData[k];
}

export function setStorageData(key: string, value: any): void {
  storageData[key] = value;
}

export function getWindowsOnRemoved(): MockEvent<[number]> {
  return windows.onRemoved;
}

export function getRuntimeOnMessage(): MockEvent<[any, any, any]> {
  return runtime.onMessage;
}

export function setRuntimeId(id: string): void {
  runtime.id = id;
}

export function setLastError(msg: string): void {
  runtime.lastError = { message: msg } as any;
}

export function clearLastError(): void {
  runtime.lastError = undefined;
}

/**
 * Configure chrome.windows.create to call its callback synchronously with
 * a mock window. By default, the callback is called with { id: 1 }.
 */
export function setupWindowsCreate(windowId: number = 1): void {
  windows.create = ((opts: any, callback?: (w: MockWindow) => void) => {
    if (callback) {
      // Simulate async callback
      setTimeout(() => callback({ id: windowId }), 0);
    }
  }) as any;
}

/**
 * Configure chrome.windows.create to trigger lastError (simulates popup
 * open failure).
 */
export function setupWindowsCreateError(errorMsg: string): void {
  setLastError(errorMsg);
  windows.create = ((opts: any, callback?: (w: MockWindow | undefined) => void) => {
    if (callback) {
      setTimeout(() => callback(undefined), 0);
    }
  }) as any;
}

export { chromeMock };
