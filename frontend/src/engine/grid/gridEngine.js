import { CELL_TYPES } from './cellTypes.js';

export const GRID_LIMITS = { MIN: 5, MAX: 80 };
export const DEFAULT_ROWS = 20;
export const DEFAULT_COLS = 30;
export const BASE_CELL_SIZE = 28; // px, at zoom scale 1

function clampDimension(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return GRID_LIMITS.MIN;
  return Math.min(GRID_LIMITS.MAX, Math.max(GRID_LIMITS.MIN, n));
}

function cellKey(x, y) {
  return `${x}:${y}`;
}

/**
 * A grid is `{ rows, cols, cells }` where `cells` is a Map keyed by
 * "x:y" holding only non-empty cells. Sparse storage keeps serialization
 * compact and resizing cheap even for large grids.
 */
export function createGrid(rows = DEFAULT_ROWS, cols = DEFAULT_COLS) {
  return { rows: clampDimension(rows), cols: clampDimension(cols), cells: new Map() };
}

export function getCell(grid, x, y) {
  return grid.cells.get(cellKey(x, y)) || CELL_TYPES.EMPTY;
}

export function isInBounds(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows;
}

/** Returns a new grid with the cell set. Setting EMPTY removes the entry. */
export function setCell(grid, x, y, type) {
  if (!isInBounds(grid, x, y)) return grid;
  const key = cellKey(x, y);
  const cells = new Map(grid.cells);
  if (type === CELL_TYPES.EMPTY) {
    cells.delete(key);
  } else {
    cells.set(key, type);
  }
  return { ...grid, cells };
}

/** Resizes the grid, keeping any existing cells that still fall in bounds. */
export function resizeGrid(grid, rows, cols) {
  const newRows = clampDimension(rows);
  const newCols = clampDimension(cols);
  const cells = new Map();
  for (const [key, type] of grid.cells) {
    const [x, y] = key.split(':').map(Number);
    if (x < newCols && y < newRows) cells.set(key, type);
  }
  return { rows: newRows, cols: newCols, cells };
}

export function clearGrid(grid) {
  return { ...grid, cells: new Map() };
}

export function countCellsByType(grid) {
  const counts = {};
  for (const type of grid.cells.values()) {
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

/** Plain-object form suitable for JSON.stringify / a future REST payload. */
export function serializeGrid(grid) {
  const cells = [];
  for (const [key, type] of grid.cells) {
    const [x, y] = key.split(':').map(Number);
    cells.push({ x, y, type });
  }
  return { rows: grid.rows, cols: grid.cols, cells };
}

/** Rebuilds a grid from serializeGrid's output, validating every field so a
 * hand-edited or corrupted file can't produce an inconsistent grid. */
export function deserializeGrid(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Not a valid grid file: expected a JSON object.');
  }

  const rows = clampDimension(data.rows ?? DEFAULT_ROWS);
  const cols = clampDimension(data.cols ?? DEFAULT_COLS);
  const validTypes = new Set(Object.values(CELL_TYPES));
  const cells = new Map();

  if (Array.isArray(data.cells)) {
    for (const entry of data.cells) {
      const x = Number(entry?.x);
      const y = Number(entry?.y);
      const type = entry?.type;
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      if (!validTypes.has(type) || type === CELL_TYPES.EMPTY) continue;
      cells.set(cellKey(x, y), type);
    }
  }

  return { rows, cols, cells };
}
