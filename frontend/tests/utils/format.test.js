import { describe, it, expect } from 'vitest';
import {
  batteryTone,
  formatCoords,
  formatDateTime,
  formatDimensions,
  formatPercent,
  formatRelativeTime,
  formatTime,
  pluralize,
  LOW_BATTERY_PERCENT,
} from '../../src/utils/format.js';

describe('formatCoords', () => {
  it('rounds sub-cell positions, since a robot mid-move is not at a whole cell', () => {
    expect(formatCoords({ x: 3.6, y: 1.2 })).toBe('X:4 Y:1');
  });

  it('has something to say about a missing cell', () => {
    expect(formatCoords(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('rounds to whole percent by default', () => {
    expect(formatPercent(84.6)).toBe('85%');
  });

  it('can keep decimals where they matter', () => {
    expect(formatPercent(84.62, { digits: 1 })).toBe('84.6%');
  });

  it('never prints NaN%', () => {
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('formatDimensions', () => {
  it('reads columns by rows, matching how the grid is described everywhere else', () => {
    expect(formatDimensions({ rows: 10, cols: 20 })).toBe('20×10');
  });
});

describe('pluralize', () => {
  it('agrees with its count', () => {
    expect(pluralize(1, 'robot')).toBe('1 robot');
    expect(pluralize(0, 'robot')).toBe('0 robots');
    expect(pluralize(3, 'robot')).toBe('3 robots');
  });

  it('takes an irregular plural', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime();

  it('is deliberately coarse rather than falsely precise', () => {
    expect(formatRelativeTime(now - 2000, now)).toBe('just now');
    expect(formatRelativeTime(now - 30000, now)).toBe('30s ago');
    expect(formatRelativeTime(now - 5 * 60000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3600000, now)).toBe('3h ago');
  });

  it('distinguishes "never heard from the server" from "heard just now"', () => {
    expect(formatRelativeTime(null, now)).toBe('never');
  });

  it('does not produce a negative age from clock skew', () => {
    expect(formatRelativeTime(now + 5000, now)).toBe('just now');
  });
});

describe('time formatting', () => {
  it('renders a timestamp', () => {
    expect(formatTime('2026-01-01T12:00:00Z')).not.toBe('');
    expect(formatDateTime('2026-01-01T12:00:00Z')).not.toBe('');
  });

  it('renders nothing rather than "Invalid Date" for junk', () => {
    expect(formatTime('not a date')).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });
});

describe('batteryTone', () => {
  it('agrees with the threshold the server uses to call a battery low', () => {
    expect(batteryTone(LOW_BATTERY_PERCENT)).toBe('critical');
    expect(batteryTone(LOW_BATTERY_PERCENT + 1)).toBe('warn');
    expect(batteryTone(51)).toBe('good');
  });
});
