/**
 * Formatting and vocabulary shared by every panel.
 *
 * These were previously re-declared per component: `STATUS_LABEL` existed
 * in the sidebar and again (differently, covering fewer cases) in the
 * orders panel, coordinates were interpolated inline in five places with
 * three different roundings, and each panel decided for itself whether a
 * battery was shown as `87.4` or `87%`. Keeping the vocabulary in one file
 * is the difference between a dashboard and five dashboards sharing a page.
 */

export const ROBOT_STATUS_LABEL = {
  idle: 'Idle',
  moving: 'Moving',
  charging: 'Charging',
  error: 'Error',
};

export const ORDER_STATUS_LABEL = {
  pending: 'Pending',
  assigned: 'Assigned',
  picked_up: 'Picked up',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const ORDER_PRIORITY_LABEL = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const OBSTACLE_TYPE_LABEL = {
  human_worker: 'Human worker',
  temporary_obstacle: 'Temporary obstacle',
  broken_robot: 'Broken robot',
  construction_zone: 'Construction zone',
};

/** Statuses that mean an order is still being worked on. */
export const ACTIVE_ORDER_STATUSES = ['pending', 'assigned', 'picked_up'];

/** Below this a robot is close enough to flat to be worth flagging. Matches
 * the backend's LOW_BATTERY_THRESHOLD (engine/robots/robotEngine.js) - a
 * robot the server considers low must not read as healthy here. */
export const LOW_BATTERY_PERCENT = 20;

export function formatCoords(cell) {
  if (!cell) return '—';
  return `X:${Math.round(cell.x)} Y:${Math.round(cell.y)}`;
}

export function formatPercent(value, { digits = 0 } = {}) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function formatDimensions({ rows, cols }) {
  return `${cols}×${rows}`;
}

export function formatTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** "3 robots" / "1 robot" - the plural rule the panels kept re-implementing
 * inline, usually only for the cases the author happened to think of. */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** How long ago, in words, for "last updated" style readouts. Coarse on
 * purpose: to the second is noise, and a live view that says "12 seconds
 * ago" invites reading it as precision it does not have. */
export function formatRelativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function batteryTone(percent) {
  if (percent > 50) return 'good';
  if (percent > LOW_BATTERY_PERCENT) return 'warn';
  return 'critical';
}
