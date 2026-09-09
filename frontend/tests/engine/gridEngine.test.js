import { describe, it, expect } from 'vitest';
import {
  createGrid,
  setCell,
  getCell,
  resizeGrid,
  clearGrid,
  serializeGrid,
  deserializeGrid,
  countCellsByType,
  isInBounds,
  GRID_LIMITS,
} from '../../src/engine/grid/gridEngine.js';
import { CELL_TYPES } from '../../src/engine/grid/cellTypes.js';
import { generateWarehouseLayout } from '../../src/engine/grid/warehouseGenerator.js';

describe('grid engine', () => {
  it('clamps dimensions to the limits the server also enforces', () => {
    expect(createGrid(1, 1).rows).toBe(GRID_LIMITS.MIN);
    expect(createGrid(999, 999).cols).toBe(GRID_LIMITS.MAX);
  });

  it('stores only non-empty cells, so an empty grid serialises to nothing', () => {
    const grid = createGrid(10, 10);

    expect(serializeGrid(grid).cells).toEqual([]);
    expect(getCell(grid, 5, 5)).toBe(CELL_TYPES.EMPTY);
  });

  it('never mutates the grid it is given', () => {
    const grid = createGrid(10, 10);

    const next = setCell(grid, 1, 1, CELL_TYPES.SHELF);

    expect(grid.cells.size).toBe(0);
    expect(next.cells.get('1:1')).toBe('shelf');
  });

  it('setting a cell to empty removes it rather than storing an empty marker', () => {
    let grid = setCell(createGrid(10, 10), 1, 1, CELL_TYPES.SHELF);

    grid = setCell(grid, 1, 1, CELL_TYPES.EMPTY);

    expect(grid.cells.has('1:1')).toBe(false);
  });

  it('ignores writes outside the grid', () => {
    const grid = createGrid(10, 10);

    expect(setCell(grid, -1, 0, CELL_TYPES.SHELF)).toBe(grid);
    expect(setCell(grid, 10, 0, CELL_TYPES.SHELF)).toBe(grid);
    expect(isInBounds(grid, 9, 9)).toBe(true);
    expect(isInBounds(grid, 10, 9)).toBe(false);
  });

  it('drops cells that fall outside a shrunk grid', () => {
    let grid = createGrid(20, 20);
    grid = setCell(grid, 15, 15, CELL_TYPES.SHELF);
    grid = setCell(grid, 2, 2, CELL_TYPES.DOCK);

    const smaller = resizeGrid(grid, 10, 10);

    expect(smaller.cells.has('15:15')).toBe(false);
    expect(smaller.cells.get('2:2')).toBe('dock');
  });

  it('counts cells by type', () => {
    let grid = createGrid(10, 10);
    grid = setCell(grid, 0, 0, CELL_TYPES.SHELF);
    grid = setCell(grid, 1, 0, CELL_TYPES.SHELF);
    grid = setCell(grid, 2, 0, CELL_TYPES.CHARGING);

    expect(countCellsByType(grid)).toEqual({ shelf: 2, charging: 1 });
  });

  it('clears every cell but keeps the dimensions', () => {
    let grid = createGrid(12, 14);
    grid = setCell(grid, 1, 1, CELL_TYPES.SHELF);

    const cleared = clearGrid(grid);

    expect(cleared.cells.size).toBe(0);
    expect(cleared).toMatchObject({ rows: 12, cols: 14 });
  });

  describe('deserializing untrusted files', () => {
    it('round-trips its own output', () => {
      let grid = createGrid(12, 14);
      grid = setCell(grid, 3, 4, CELL_TYPES.OBSTACLE);

      const restored = deserializeGrid(serializeGrid(grid));

      expect(restored.cells.get('3:4')).toBe('obstacle');
      expect(restored.rows).toBe(12);
    });

    it('rejects something that is not a grid at all', () => {
      expect(() => deserializeGrid(null)).toThrow(/not a valid grid file/i);
      expect(() => deserializeGrid('nope')).toThrow(/not a valid grid file/i);
    });

    it('silently drops entries a hand-edited file could contain', () => {
      const grid = deserializeGrid({
        rows: 10,
        cols: 10,
        cells: [
          { x: 1, y: 1, type: 'shelf' },
          { x: 1.5, y: 1, type: 'shelf' }, // not an integer
          { x: -1, y: 1, type: 'shelf' }, // out of bounds
          { x: 50, y: 1, type: 'shelf' }, // out of bounds
          { x: 2, y: 2, type: 'lava' }, // not a cell type
          { x: 3, y: 3, type: 'empty' }, // empty is absence, not a value
          null,
        ],
      });

      expect([...grid.cells.entries()]).toEqual([['1:1', 'shelf']]);
    });

    it('falls back to default dimensions when they are missing', () => {
      const grid = deserializeGrid({ cells: [] });

      expect(grid.rows).toBeGreaterThanOrEqual(GRID_LIMITS.MIN);
      expect(grid.cols).toBeGreaterThanOrEqual(GRID_LIMITS.MIN);
    });
  });
});

describe('warehouse generator', () => {
  it('fills the grid it is asked for, at the right dimensions', () => {
    const grid = generateWarehouseLayout({ rows: 20, cols: 30, density: 'balanced' });

    expect(grid).toMatchObject({ rows: 20, cols: 30 });
    expect(grid.cells.size).toBeGreaterThan(0);
  });

  it('places more when asked for a denser layout', () => {
    const sparse = generateWarehouseLayout({ rows: 30, cols: 40, density: 'sparse' });
    const dense = generateWarehouseLayout({ rows: 30, cols: 40, density: 'dense' });

    expect(dense.cells.size).toBeGreaterThan(sparse.cells.size);
  });

  it('produces only real cell types, and leaves room to move', () => {
    const grid = generateWarehouseLayout({ rows: 20, cols: 30, density: 'dense' });
    const validTypes = new Set(Object.values(CELL_TYPES));

    for (const type of grid.cells.values()) {
      expect(validTypes.has(type)).toBe(true);
      expect(type).not.toBe(CELL_TYPES.EMPTY);
    }
    // A layout with no aisles would be a warehouse no robot can cross.
    expect(grid.cells.size).toBeLessThan(grid.rows * grid.cols);
  });

  it('includes somewhere to charge and somewhere to dock', () => {
    const grid = generateWarehouseLayout({ rows: 20, cols: 30, density: 'balanced' });
    const types = new Set(grid.cells.values());

    expect(types.has(CELL_TYPES.CHARGING)).toBe(true);
    expect(types.has(CELL_TYPES.DOCK)).toBe(true);
  });
});
