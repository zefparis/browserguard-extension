/**
 * Phase 6 — content-script collection gating (SANS CLE = RIEN).
 *
 * The content script must not attach ANY DOM listener until the SW
 * confirms a provisioned key exists, and must start/stop on
 * browserguard_collection_state broadcasts.
 *
 * What is covered here: enable/disable lifecycle, listener attach/detach,
 * event capture only while enabled, flush gating, the collection_query
 * handshake and the broadcast listener (initContentScript).
 *
 * NOT covered (manual test): real DOM event delivery in a page, real
 * chrome.runtime messaging, real GPO policy. Verified manually via the
 * README "Test extension" section.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enableCollection,
  disableCollection,
  flush,
  initContentScript,
  __testGetCollectionState,
} from '../src/content-script';

// ─── Minimal document stub ──────────────────────────────────────────

type Listener = (e: any) => void;

class DocumentStub {
  listeners = new Map<string, Listener[]>();
  visibilityState = 'visible';

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }

  dispatch(type: string, event: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

let doc: DocumentStub;
let sendMessageMock: ReturnType<typeof vi.fn>;
let onMessageListeners: ((msg: any) => void)[];

beforeEach(() => {
  doc = new DocumentStub();
  onMessageListeners = [];
  sendMessageMock = vi.fn();
  (globalThis as any).document = doc;
  (globalThis as any).window = {
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    scrollY: 0,
    location: { href: 'https://example.test/' },
  };
  (globalThis as any).chrome = {
    runtime: {
      id: 'test-ext',
      sendMessage: sendMessageMock,
      onMessage: { addListener: (fn: (msg: any) => void) => onMessageListeners.push(fn) },
    },
  };
  // Ensure clean module state between tests
  disableCollection();
});

afterEach(() => {
  disableCollection();
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).chrome;
});

function emitBroadcast(enabled: boolean): void {
  for (const fn of onMessageListeners) {
    fn({ type: 'browserguard_collection_state', enabled });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('listener lifecycle', () => {
  it('attaches no DOM listener until collection is enabled', () => {
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(doc.listenerCount('keyup')).toBe(0);
    expect(doc.listenerCount('mousemove')).toBe(0);
    expect(doc.listenerCount('scroll')).toBe(0);
    expect(__testGetCollectionState().enabled).toBe(false);
  });

  it('enableCollection attaches all four listeners', () => {
    enableCollection();
    expect(doc.listenerCount('keydown')).toBe(1);
    expect(doc.listenerCount('keyup')).toBe(1);
    expect(doc.listenerCount('mousemove')).toBe(1);
    expect(doc.listenerCount('scroll')).toBe(1);
  });

  it('enableCollection is idempotent', () => {
    enableCollection();
    enableCollection();
    expect(doc.listenerCount('keydown')).toBe(1);
  });

  it('disableCollection detaches everything and resets accumulators', () => {
    enableCollection();
    doc.dispatch('keydown', { isTrusted: true });
    doc.dispatch('keyup', { isTrusted: true });
    doc.dispatch('keydown', { isTrusted: true });
    doc.dispatch('keyup', { isTrusted: true });
    doc.dispatch('mousemove', { isTrusted: true, clientX: 1, clientY: 1 });
    expect(__testGetCollectionState().keystrokes).toBeGreaterThan(0);

    disableCollection();
    expect(doc.listenerCount('keydown')).toBe(0);
    expect(__testGetCollectionState().keystrokes).toBe(0);
    expect(__testGetCollectionState().enabled).toBe(false);

    // Events dispatched after detach cannot reach any handler.
    doc.dispatch('keydown', { isTrusted: true });
    doc.dispatch('keyup', { isTrusted: true });
    expect(__testGetCollectionState().keystrokes).toBe(0);
  });
});

describe('capture only while enabled', () => {
  it('flush() sends nothing while disabled', () => {
    flush();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('flush() sends a behavior_snapshot while enabled', () => {
    enableCollection();
    doc.dispatch('mousemove', { isTrusted: true, clientX: 5, clientY: 5 });
    flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0][0];
    expect(msg.type).toBe('browserguard_behavior_snapshot');
    expect(msg.snapshot.mouseEventCount).toBeGreaterThan(0);
  });

  it('synthetic events are rejected even while enabled', () => {
    enableCollection();
    doc.dispatch('mousemove', { isTrusted: false, clientX: 1, clientY: 1 });
    expect(__testGetCollectionState().mouseEvents).toBe(0);
  });
});

describe('init handshake', () => {
  it('queries the SW and starts collection when enabled=true', () => {
    sendMessageMock.mockImplementation((msg: any, cb?: (r: any) => void) => {
      if (msg.type === 'browserguard_collection_query' && cb) {
        cb({ collectionEnabled: true });
      }
    });
    initContentScript();
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'browserguard_collection_query' },
      expect.any(Function),
    );
    expect(__testGetCollectionState().enabled).toBe(true);
    expect(doc.listenerCount('keydown')).toBe(1);
  });

  it('stays disabled when the SW answers enabled=false', () => {
    sendMessageMock.mockImplementation((msg: any, cb?: (r: any) => void) => {
      if (msg.type === 'browserguard_collection_query' && cb) cb({ collectionEnabled: false });
    });
    initContentScript();
    expect(__testGetCollectionState().enabled).toBe(false);
  });

  it('stays disabled when the SW is unreachable (sendMessage throws)', () => {
    sendMessageMock.mockImplementation(() => { throw new Error('SW dead'); });
    expect(() => initContentScript()).not.toThrow();
    expect(__testGetCollectionState().enabled).toBe(false);
  });

  it('starts on enabled=true broadcast and stops on enabled=false', () => {
    sendMessageMock.mockImplementation((msg: any, cb?: (r: any) => void) => {
      if (msg.type === 'browserguard_collection_query' && cb) cb({ collectionEnabled: false });
    });
    initContentScript();
    expect(onMessageListeners.length).toBe(1);
    expect(__testGetCollectionState().enabled).toBe(false);

    // Key appears → SW broadcasts → collection starts without reload
    emitBroadcast(true);
    expect(__testGetCollectionState().enabled).toBe(true);
    expect(doc.listenerCount('keydown')).toBe(1);

    // Key removed → broadcast → collection stops, buffers dropped
    emitBroadcast(false);
    expect(__testGetCollectionState().enabled).toBe(false);
    expect(doc.listenerCount('keydown')).toBe(0);
  });

  it('ignores unrelated message types', () => {
    initContentScript();
    for (const fn of onMessageListeners) fn({ type: 'something_else', enabled: true });
    expect(__testGetCollectionState().enabled).toBe(false);
  });
});
