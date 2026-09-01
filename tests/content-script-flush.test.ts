/**
 * Tests — content-script.ts flush() reset behavior
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates that flush() correctly resets ALL accumulators after building
 * a snapshot, so each 5s window's snapshot contains only that window's data.
 *
 * The content script can't be imported directly (it attaches DOM listeners
 * and starts setInterval at module load). Instead, we reproduce the flush/
 * buildSnapshot logic in isolation — same pattern used for gateguard-service
 * embed.js tests.
 *
 * Bug being fixed: previously only mouseSpeeds/mouseCurvatures were reset,
 * causing keystrokes/mouseEvents/scrollEvents/scrollSpeeds/pauseCounts to
 * accumulate across windows. The fix adds resets for all accumulators and
 * tracking variables.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2541274 | CC BY-NC-SA 4.0
 */

import { describe, it, expect } from 'vitest';

// ─── Types (mirrors content-script.ts) ──────────────────────────────

interface KeystrokeEvent {
  timestamp: number;
  duration: number;
}

interface CapturedMouseEvent {
  timestamp: number;
  x: number;
  y: number;
}

interface ScrollEvent {
  timestamp: number;
  scrollY: number;
}

interface BehaviorSnapshot {
  keystrokeIntervals: number[];
  keystrokeHolds: number[];
  keystrokeCount: number;
  mouseSpeeds: number[];
  mouseCurvatures: number[];
  mousePauseCount: number;
  mouseEventCount: number;
  scrollSpeeds: number[];
  scrollPauseCount: number;
  scrollEventCount: number;
  totalEvents: number;
  timestamp: string;
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
}

// ─── State (mirrors content-script.ts module-level state) ───────────

function createState() {
  return {
    keystrokes: [] as KeystrokeEvent[],
    mouseEvents: [] as CapturedMouseEvent[],
    scrollEvents: [] as ScrollEvent[],

    lastKeystrokeTime: 0,
    lastMouseTime: 0,
    lastMouseX: 0,
    lastMouseY: 0,
    lastScrollTime: 0,
    lastScrollY: 0,
    mousePauseCount: 0,
    scrollPauseCount: 0,

    lastMouseMoveTime: 0,
    mouseSpeeds: [] as number[],
    mouseCurvatures: [] as number[],
    scrollSpeeds: [] as number[],

    prevMouseMove: null as { x: number; y: number; t: number } | null,
    prevPrevMouseMove: null as { x: number; y: number; t: number } | null,
  };
}

type State = ReturnType<typeof createState>;

// ─── buildSnapshot (mirrors content-script.ts) ──────────────────────

function buildSnapshot(s: State): BehaviorSnapshot {
  const keystrokeIntervals: number[] = [];
  for (let i = 1; i < s.keystrokes.length; i++) {
    keystrokeIntervals.push(s.keystrokes[i].timestamp - s.keystrokes[i - 1].timestamp);
  }
  const keystrokeHolds = s.keystrokes.map((k) => k.duration);

  return {
    keystrokeIntervals,
    keystrokeHolds,
    keystrokeCount: s.keystrokes.length,
    mouseSpeeds: [...s.mouseSpeeds],
    mouseCurvatures: [...s.mouseCurvatures],
    mousePauseCount: s.mousePauseCount,
    mouseEventCount: s.mouseEvents.length,
    scrollSpeeds: [...s.scrollSpeeds],
    scrollPauseCount: s.scrollPauseCount,
    scrollEventCount: s.scrollEvents.length,
    totalEvents: s.keystrokes.length + s.mouseEvents.length + s.scrollEvents.length,
    timestamp: new Date().toISOString(),
    viewportWidth: 1920,
    viewportHeight: 1080,
    pixelRatio: 1,
  };
}

// ─── flush (mirrors the FIXED content-script.ts) ────────────────────

function flush(s: State): BehaviorSnapshot {
  const snapshot = buildSnapshot(s);

  // Reset all accumulators (the fix)
  s.keystrokes.length = 0;
  s.mouseEvents.length = 0;
  s.scrollEvents.length = 0;
  s.mouseSpeeds = [];
  s.mouseCurvatures = [];
  s.scrollSpeeds = [];
  s.mousePauseCount = 0;
  s.scrollPauseCount = 0;

  // Reset tracking variables
  s.lastKeystrokeTime = 0;
  s.lastScrollTime = 0;
  s.lastScrollY = 0;
  s.prevMouseMove = null;
  s.prevPrevMouseMove = null;

  return snapshot;
}

// ─── Simulators (push events into state) ────────────────────────────

function simulateKeystrokes(s: State, count: number, startTime: number): void {
  for (let i = 0; i < count; i++) {
    const ts = startTime + i * 120; // 120ms between keystrokes
    s.keystrokes.push({ timestamp: ts, duration: 80 + Math.random() * 20 });
  }
  if (count > 0) {
    s.lastKeystrokeTime = startTime + (count - 1) * 120;
  }
}

function simulateMouseEvents(s: State, count: number, startTime: number): void {
  for (let i = 0; i < count; i++) {
    const ts = startTime + i * 30;
    s.mouseEvents.push({ timestamp: ts, x: i * 10, y: i * 5 });
    s.mouseSpeeds.push(0.5 + Math.random() * 0.3);
    s.mouseCurvatures.push(Math.random() * 0.5);
  }
  if (count > 0) {
    s.mousePauseCount = Math.floor(count / 10);
  }
}

function simulateScrollEvents(s: State, count: number, startTime: number): void {
  for (let i = 0; i < count; i++) {
    const ts = startTime + i * 50;
    s.scrollEvents.push({ timestamp: ts, scrollY: i * 100 });
    s.scrollSpeeds.push(2 + Math.random());
  }
  if (count > 0) {
    s.scrollPauseCount = Math.floor(count / 8);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('content-script flush() — accumulator reset', () => {
  it('first flush contains all events from window 1', () => {
    const s = createState();
    simulateKeystrokes(s, 10, 1000);
    simulateMouseEvents(s, 50, 1000);
    simulateScrollEvents(s, 20, 1000);

    const snapshot = flush(s);

    expect(snapshot.keystrokeCount).toBe(10);
    expect(snapshot.mouseEventCount).toBe(50);
    expect(snapshot.scrollEventCount).toBe(20);
    expect(snapshot.totalEvents).toBe(80);
    expect(snapshot.mousePauseCount).toBe(5); // floor(50/10)
    expect(snapshot.scrollPauseCount).toBe(2); // floor(20/8)
    expect(snapshot.mouseSpeeds.length).toBe(50);
    expect(snapshot.mouseCurvatures.length).toBe(50);
    expect(snapshot.scrollSpeeds.length).toBe(20);
  });

  it('second flush contains ONLY events from window 2 (not cumulative)', () => {
    const s = createState();

    // Window 1
    simulateKeystrokes(s, 10, 1000);
    simulateMouseEvents(s, 50, 1000);
    simulateScrollEvents(s, 20, 1000);
    flush(s);

    // Window 2 — different counts
    simulateKeystrokes(s, 5, 6000);
    simulateMouseEvents(s, 15, 6000);
    simulateScrollEvents(s, 8, 6000);

    const snapshot2 = flush(s);

    // Should contain ONLY window 2 data, not cumulative
    expect(snapshot2.keystrokeCount).toBe(5);
    expect(snapshot2.mouseEventCount).toBe(15);
    expect(snapshot2.scrollEventCount).toBe(8);
    expect(snapshot2.totalEvents).toBe(28);
    expect(snapshot2.mousePauseCount).toBe(1); // floor(15/10)
    expect(snapshot2.scrollPauseCount).toBe(1); // floor(8/8)
    expect(snapshot2.mouseSpeeds.length).toBe(15);
    expect(snapshot2.mouseCurvatures.length).toBe(15);
    expect(snapshot2.scrollSpeeds.length).toBe(8);
  });

  it('flush with no new events produces empty snapshot (not stale data)', () => {
    const s = createState();

    // Window 1 — some events
    simulateKeystrokes(s, 10, 1000);
    simulateMouseEvents(s, 30, 1000);
    simulateScrollEvents(s, 15, 1000);
    flush(s);

    // Window 2 — no new events (user idle)
    const snapshot2 = flush(s);

    expect(snapshot2.keystrokeCount).toBe(0);
    expect(snapshot2.mouseEventCount).toBe(0);
    expect(snapshot2.scrollEventCount).toBe(0);
    expect(snapshot2.totalEvents).toBe(0);
    expect(snapshot2.mousePauseCount).toBe(0);
    expect(snapshot2.scrollPauseCount).toBe(0);
    expect(snapshot2.mouseSpeeds.length).toBe(0);
    expect(snapshot2.mouseCurvatures.length).toBe(0);
    expect(snapshot2.scrollSpeeds.length).toBe(0);
  });

  it('three consecutive flushes each contain only their own window data', () => {
    const s = createState();

    // Window 1
    simulateKeystrokes(s, 8, 1000);
    simulateMouseEvents(s, 40, 1000);
    simulateScrollEvents(s, 12, 1000);
    const snap1 = flush(s);

    // Window 2
    simulateKeystrokes(s, 3, 6000);
    simulateMouseEvents(s, 20, 6000);
    simulateScrollEvents(s, 5, 6000);
    const snap2 = flush(s);

    // Window 3
    simulateKeystrokes(s, 15, 11000);
    simulateMouseEvents(s, 60, 11000);
    simulateScrollEvents(s, 25, 11000);
    const snap3 = flush(s);

    expect(snap1.totalEvents).toBe(60);
    expect(snap2.totalEvents).toBe(28);
    expect(snap3.totalEvents).toBe(100);

    // No cumulative leakage
    expect(snap2.keystrokeCount).toBe(3);
    expect(snap3.keystrokeCount).toBe(15);
    expect(snap2.mouseEventCount).toBe(20);
    expect(snap3.mouseEventCount).toBe(60);
  });

  it('reset clears tracking variables (no cross-window speed/interval artifacts)', () => {
    const s = createState();

    // Window 1 — establish tracking state
    simulateKeystrokes(s, 5, 1000);
    simulateMouseEvents(s, 20, 1000);
    simulateScrollEvents(s, 10, 1000);
    flush(s);

    // After flush, tracking variables should be reset
    expect(s.lastKeystrokeTime).toBe(0);
    expect(s.lastScrollTime).toBe(0);
    expect(s.lastScrollY).toBe(0);
    expect(s.prevMouseMove).toBeNull();
    expect(s.prevPrevMouseMove).toBeNull();
  });

  it('snapshot is built BEFORE reset (data is not lost)', () => {
    const s = createState();
    simulateKeystrokes(s, 10, 1000);
    simulateMouseEvents(s, 30, 1000);
    simulateScrollEvents(s, 15, 1000);

    // flush returns the snapshot built from current state, THEN resets
    const snapshot = flush(s);

    // Snapshot should have the data
    expect(snapshot.keystrokeCount).toBe(10);
    expect(snapshot.mouseEventCount).toBe(30);
    expect(snapshot.scrollEventCount).toBe(15);

    // State should be empty after flush
    expect(s.keystrokes.length).toBe(0);
    expect(s.mouseEvents.length).toBe(0);
    expect(s.scrollEvents.length).toBe(0);
  });
});
