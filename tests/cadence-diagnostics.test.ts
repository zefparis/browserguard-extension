/**
 * Tests — think-time cadence diagnostic fields (burstRatio, interEventGapStd)
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates the calculation of the two diagnostic fields added to the
 * BrowserGuard snapshot for offline calibration of think-time cadence
 * detection. These fields are NOT scored by computeDivergence or any
 * risk engine — this test only verifies the math.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | CC BY-NC-SA 4.0
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

// ─── computeCadenceDiagnostics (mirrors content-script.ts) ──────────

const FLUSH_INTERVAL_MS = 5_000;

function computeCadenceDiagnostics(
  keystrokes: KeystrokeEvent[],
  mouseEvents: CapturedMouseEvent[],
  scrollEvents: ScrollEvent[],
): {
  burstRatio: number | null;
  interEventGapStd: number | null;
} {
  const allTimestamps: number[] = [];
  for (const k of keystrokes) allTimestamps.push(k.timestamp);
  for (const m of mouseEvents) allTimestamps.push(m.timestamp);
  for (const s of scrollEvents) allTimestamps.push(s.timestamp);

  if (allTimestamps.length < 2) {
    return { burstRatio: null, interEventGapStd: null };
  }

  allTimestamps.sort((a, b) => a - b);

  const firstTs = allTimestamps[0];
  const lastTs = allTimestamps[allTimestamps.length - 1];
  const activeSpan = lastTs - firstTs;
  const burstRatio = Math.min(1, activeSpan / FLUSH_INTERVAL_MS);

  const gaps: number[] = [];
  for (let i = 1; i < allTimestamps.length; i++) {
    gaps.push(allTimestamps[i] - allTimestamps[i - 1]);
  }
  const gapMean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  const gapVariance = gaps.reduce((s, v) => s + (v - gapMean) ** 2, 0) / gaps.length;
  const interEventGapStd = Math.sqrt(gapVariance);

  return {
    burstRatio: Math.round(burstRatio * 1000) / 1000,
    interEventGapStd: Math.round(interEventGapStd * 100) / 100,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('computeCadenceDiagnostics — think-time cadence calibration', () => {

  it('returns null for both fields when 0 events', () => {
    const result = computeCadenceDiagnostics([], [], []);
    expect(result.burstRatio).toBeNull();
    expect(result.interEventGapStd).toBeNull();
  });

  it('returns null for both fields when 1 event', () => {
    const result = computeCadenceDiagnostics(
      [{ timestamp: 1000, duration: 80 }],
      [],
      [],
    );
    expect(result.burstRatio).toBeNull();
    expect(result.interEventGapStd).toBeNull();
  });

  it('returns null when only 1 event across all types', () => {
    const result = computeCadenceDiagnostics(
      [],
      [{ timestamp: 2000, x: 10, y: 20 }],
      [],
    );
    expect(result.burstRatio).toBeNull();
    expect(result.interEventGapStd).toBeNull();
  });

  it('2 events close together → low burstRatio, low interEventGapStd', () => {
    // Two mouse events 50ms apart, at the start of the window
    const result = computeCadenceDiagnostics(
      [],
      [
        { timestamp: 100, x: 0, y: 0 },
        { timestamp: 150, x: 10, y: 5 },
      ],
      [],
    );
    // activeSpan = 50ms, burstRatio = 50/5000 = 0.01
    expect(result.burstRatio).toBe(0.01);
    // Only 1 gap of 50ms → std = 0
    expect(result.interEventGapStd).toBe(0);
  });

  it('2 events 4s apart → high burstRatio, high interEventGapStd', () => {
    // Two events 4000ms apart
    const result = computeCadenceDiagnostics(
      [{ timestamp: 500, duration: 80 }],
      [],
      [{ timestamp: 4500, scrollY: 100 }],
    );
    // activeSpan = 4000ms, burstRatio = 4000/5000 = 0.8
    expect(result.burstRatio).toBe(0.8);
    // Only 1 gap of 4000ms → std = 0 (single gap has no variance)
    expect(result.interEventGapStd).toBe(0);
  });

  it('burst-then-silence pattern → high interEventGapStd', () => {
    // 5 events in a burst (10ms apart), then 1 event 3000ms later
    const mouseEvents: CapturedMouseEvent[] = [];
    for (let i = 0; i < 5; i++) {
      mouseEvents.push({ timestamp: 100 + i * 10, x: i, y: 0 });
    }
    mouseEvents.push({ timestamp: 100 + 4 * 10 + 3000, x: 50, y: 0 });

    const result = computeCadenceDiagnostics([], mouseEvents, []);

    // activeSpan = 3040ms, burstRatio = 3040/5000 ≈ 0.608
    expect(result.burstRatio).toBe(0.608);

    // Gaps: [10, 10, 10, 10, 3000]
    // mean = 608, variance = ((10-608)²*4 + (3000-608)²) / 5
    // = (598²*4 + 2392²) / 5 = (357604*4 + 5721664) / 5
    // = (1430416 + 5721664) / 5 = 7152080 / 5 = 1430416
    // std = sqrt(1430416) ≈ 1196
    expect(result.interEventGapStd).toBe(1196);
  });

  it('continuous interaction → low interEventGapStd', () => {
    // 10 events evenly spaced 100ms apart
    const mouseEvents: CapturedMouseEvent[] = [];
    for (let i = 0; i < 10; i++) {
      mouseEvents.push({ timestamp: 100 + i * 100, x: i * 10, y: 0 });
    }

    const result = computeCadenceDiagnostics([], mouseEvents, []);

    // activeSpan = 900ms, burstRatio = 900/5000 = 0.18
    expect(result.burstRatio).toBe(0.18);

    // All gaps = 100ms → std = 0
    expect(result.interEventGapStd).toBe(0);
  });

  it('events spanning full window → burstRatio near 1', () => {
    // Events at t=0 and t=4999
    const result = computeCadenceDiagnostics(
      [{ timestamp: 0, duration: 80 }],
      [{ timestamp: 4999, x: 100, y: 100 }],
      [],
    );
    // activeSpan = 4999, burstRatio = 4999/5000 = 0.9998 → rounded to 1.0
    expect(result.burstRatio).toBe(1);
  });

  it('events spanning beyond window → burstRatio capped at 1', () => {
    // Events at t=0 and t=6000 (shouldn't happen in practice, but test the cap)
    const result = computeCadenceDiagnostics(
      [{ timestamp: 0, duration: 80 }],
      [{ timestamp: 6000, x: 100, y: 100 }],
      [],
    );
    expect(result.burstRatio).toBe(1);
  });

  it('mixes all three event types correctly', () => {
    // keystroke at t=100, mouse at t=200, scroll at t=300
    const result = computeCadenceDiagnostics(
      [{ timestamp: 100, duration: 80 }],
      [{ timestamp: 200, x: 10, y: 10 }],
      [{ timestamp: 300, scrollY: 50 }],
    );
    // activeSpan = 200ms, burstRatio = 200/5000 = 0.04
    expect(result.burstRatio).toBe(0.04);
    // Gaps: [100, 100] → mean=100, std=0
    expect(result.interEventGapStd).toBe(0);
  });

  it('timestamps are sorted correctly regardless of insertion order', () => {
    // Insert out of order: mouse, keystroke, scroll
    const result = computeCadenceDiagnostics(
      [{ timestamp: 200, duration: 80 }],
      [{ timestamp: 100, x: 10, y: 10 }],
      [{ timestamp: 300, scrollY: 50 }],
    );
    // Should be same as the ordered test above
    expect(result.burstRatio).toBe(0.04);
    expect(result.interEventGapStd).toBe(0);
  });
});
