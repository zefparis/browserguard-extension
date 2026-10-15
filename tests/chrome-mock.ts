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
  onStartup: new MockEvent<[]>(),
  onInstalled: new MockEvent<[{ reason: string }?]>(),
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

// ─── chrome.tabs ────────────────────────────────────────────────────
// tabs.query/tabs.sendMessage need no "tabs" permission (only tab.id is
// used — a non-sensitive field). sendMessage delivers to content-script
// onMessage listeners registered by tests; tabs without a listener set
// lastError, like real Chrome.

interface MockTab {
  id?: number;
  url?: string;
}

const tabsState = {
  tabs: [] as MockTab[],
  sendMessageCalls: [] as { tabId: number; message: any }[],
  createCalls: [] as { url?: string }[],
  /** Listeners emulating content scripts, keyed by tabId. */
  tabListeners: new Map<number, (msg: any) => void>(),
};

const tabs = {
  // tabs.create needs no "tabs" permission, used by step-up/options/popup
  // pages to open the public proof link in a new tab.
  create: (props: { url?: string }, callback?: (tab: MockTab) => void): Promise<MockTab> | void => {
    tabsState.createCalls.push({ url: props?.url });
    const tab: MockTab = { id: 10_000 + tabsState.createCalls.length, url: props?.url };
    tabsState.tabs.push(tab);
    if (callback) {
      setTimeout(() => callback(tab), 0);
      return;
    }
    return Promise.resolve(tab);
  },
  query: (queryInfo: any, callback?: (tabs: MockTab[]) => void): Promise<MockTab[]> | void => {
    const result = tabsState.tabs;
    if (callback) {
      setTimeout(() => callback(result), 0);
      return;
    }
    return Promise.resolve(result);
  },
  sendMessage: (tabId: number, message: any, callback?: () => void): void => {
    tabsState.sendMessageCalls.push({ tabId, message });
    const listener = tabsState.tabListeners.get(tabId);
    if (listener) {
      listener(message);
      runtime.lastError = undefined;
    } else {
      // Emulate "Could not establish connection" for tabs without a
      // content script — broadcastCollectionState swallows lastError.
      runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' } as any;
    }
    if (callback) setTimeout(callback, 0);
  },
};

// ─── chrome.storage.local / chrome.storage.managed ──────────────────

const storageData: Record<string, any> = {};
const managedData: Record<string, any> = {};
const sessionData: Record<string, any> = {};

function storageArea(data: Record<string, any>) {
  return {
    get: (keys: string | string[], callback: (result: Record<string, any>) => void): void => {
      const keyList = typeof keys === 'string' ? [keys] : keys;
      const result: Record<string, any> = {};
      for (const k of keyList) {
        if (k in data) result[k] = data[k];
      }
      // Simulate async callback
      setTimeout(() => callback(result), 0);
    },
    set: (items: Record<string, any>): void => {
      Object.assign(data, items);
    },
    remove: (key: string | string[]): void => {
      for (const k of typeof key === 'string' ? [key] : key) {
        delete data[k];
      }
    },
  };
}

const storage = {
  local: storageArea(storageData),
  managed: storageArea(managedData),
  // chrome.storage.session — in-memory area, no extra permission beyond
  // "storage". Survives SW sleep, cleared on browser restart.
  session: storageArea(sessionData),
  onChanged: new MockEvent<[Record<string, { oldValue?: any; newValue?: any }>, string]>(),
};

// ─── chrome.action ──────────────────────────────────────────────────
// Badge/title APIs need no permission when "action" is declared in the
// manifest (which it already is). The mock records every call.

const actionCalls = {
  badgeText: [] as { text: string }[],
  badgeColor: [] as { color: string }[],
  title: [] as { title: string }[],
};

const action = {
  setBadgeText: (details: { text: string }) => { actionCalls.badgeText.push(details); return Promise.resolve(); },
  setBadgeBackgroundColor: (details: { color: string }) => { actionCalls.badgeColor.push(details); return Promise.resolve(); },
  setTitle: (details: { title: string }) => { actionCalls.title.push(details); return Promise.resolve(); },
};

// ─── chrome.alarms ──────────────────────────────────────────────────
// Minimal mock: tracks created alarms and fires onAlarm listeners.
// Tests can emit alarms via getAlarmsOnAlarm().emit() to simulate
// chrome.alarms waking the service worker.

interface MockAlarm {
  name: string;
  periodInMinutes?: number;
  scheduledTime: number;
}

const alarmsStore: Map<string, MockAlarm> = new Map();

const alarms = {
  onAlarm: new MockEvent<[chrome.alarms.Alarm]>(),
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void => {
    // chrome.alarms.create replaces any existing alarm with the same name
    alarmsStore.set(name, {
      name,
      periodInMinutes: alarmInfo.periodInMinutes,
      scheduledTime: Date.now() + (alarmInfo.delayInMinutes ?? 0) * 60_000,
    });
  },
  clear: (name: string): boolean => {
    return alarmsStore.delete(name);
  },
  get: (name: string): MockAlarm | undefined => {
    return alarmsStore.get(name);
  },
  getAll: (): MockAlarm[] => {
    return Array.from(alarmsStore.values());
  },
};

// ─── Assemble global chrome ─────────────────────────────────────────

const chromeMock = {
  runtime,
  windows,
  storage,
  alarms,
  tabs,
  action,
};

// Expose on globalThis so `typeof chrome !== 'undefined'` is true in tests
(globalThis as any).chrome = chromeMock;

// ─── Test helpers ───────────────────────────────────────────────────

export function resetChromeMock(): void {
  runtime.id = 'vitest-test-extension';
  runtime.lastError = undefined;
  runtime.onMessage = new MockEvent();
  runtime.onStartup = new MockEvent();
  runtime.onInstalled = new MockEvent();
  windows.onRemoved = new MockEvent();
  alarms.onAlarm = new MockEvent();
  alarmsStore.clear();
  for (const k of Object.keys(storageData)) delete storageData[k];
  for (const k of Object.keys(managedData)) delete managedData[k];
  for (const k of Object.keys(sessionData)) delete sessionData[k];
  actionCalls.badgeText.length = 0;
  actionCalls.badgeColor.length = 0;
  actionCalls.title.length = 0;
  storage.onChanged = new MockEvent();
  tabsState.tabs = [];
  tabsState.sendMessageCalls = [];
  tabsState.createCalls = [];
  tabsState.tabListeners.clear();
}

export function setStorageData(key: string, value: any): void {
  storageData[key] = value;
}

export function setManagedData(key: string, value: any): void {
  managedData[key] = value;
}

export function setSessionData(key: string, value: any): void {
  sessionData[key] = value;
}

export function getSessionData(): Record<string, any> {
  return sessionData;
}

export function getActionCalls() {
  return actionCalls;
}

export function getStorageOnChanged(): MockEvent<[Record<string, { oldValue?: any; newValue?: any }>, string]> {
  return storage.onChanged;
}

export function getTabsState() {
  return tabsState;
}

export function getWindowsOnRemoved(): MockEvent<[number]> {
  return windows.onRemoved;
}

export function getRuntimeOnMessage(): MockEvent<[any, any, any]> {
  return runtime.onMessage;
}

export function getAlarmsOnAlarm(): MockEvent<[chrome.alarms.Alarm]> {
  return alarms.onAlarm;
}

export function getAlarmFromStore(name: string): MockAlarm | undefined {
  return alarmsStore.get(name);
}

export function emitAlarm(name: string): void {
  const alarm = alarmsStore.get(name);
  if (alarm) {
    alarms.onAlarm.emit(alarm as chrome.alarms.Alarm);
  }
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
