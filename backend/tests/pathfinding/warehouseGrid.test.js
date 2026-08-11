const { warehouseToGrid } = require('../../src/engine/grid/warehouseGrid');
const { findPath } = require('../../src/engine/pathfinding/astar');

describe('warehouseToGrid', () => {
  it('marks shelf and obstacle cells as blocked', () => {
    const warehouse = {
      rows: 5,
      cols: 5,
      cells: [
        { x: 1, y: 1, type: 'shelf' },
        { x: 3, y: 1, type: 'obstacle' },
      ],
    };
    const grid = warehouseToGrid(warehouse);
    expect(grid.isBlocked(1, 1)).toBe(true);
    expect(grid.isBlocked(3, 1)).toBe(true);
  });

  it('treats charging, dock, and empty cells as walkable', () => {
    const warehouse = {
      rows: 5,
      cols: 5,
      cells: [
        { x: 2, y: 1, type: 'charging' },
        { x: 4, y: 4, type: 'dock' },
      ],
    };
    const grid = warehouseToGrid(warehouse);
    expect(grid.isBlocked(2, 1)).toBe(false);
    expect(grid.isBlocked(4, 4)).toBe(false);
    expect(grid.isBlocked(0, 0)).toBe(false); // never listed -> empty -> walkable
  });

  it('reports isCharging only for charging-type cells', () => {
    const warehouse = {
      rows: 5,
      cols: 5,
      cells: [
        { x: 2, y: 1, type: 'charging' },
        { x: 4, y: 4, type: 'dock' },
      ],
    };
    const grid = warehouseToGrid(warehouse);
    expect(grid.isCharging(2, 1)).toBe(true);
    expect(grid.isCharging(4, 4)).toBe(false);
    expect(grid.isCharging(0, 0)).toBe(false);
  });

  it('reports isDock only for dock-type cells', () => {
    const warehouse = {
      rows: 5,
      cols: 5,
      cells: [
        { x: 2, y: 1, type: 'charging' },
        { x: 4, y: 4, type: 'dock' },
      ],
    };
    const grid = warehouseToGrid(warehouse);
    expect(grid.isDock(4, 4)).toBe(true);
    expect(grid.isDock(2, 1)).toBe(false);
    expect(grid.isDock(0, 0)).toBe(false);
  });

  it('plugs directly into findPath and routes around blocked cells', () => {
    const warehouse = {
      rows: 6,
      cols: 6,
      cells: [
        { x: 3, y: 0, type: 'shelf' },
        { x: 3, y: 1, type: 'shelf' },
        { x: 3, y: 2, type: 'shelf' },
        { x: 3, y: 3, type: 'shelf' },
        { x: 3, y: 4, type: 'shelf' },
        // gap at (3,5)
      ],
    };
    const grid = warehouseToGrid(warehouse);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 5, y: 0 });

    expect(result.found).toBe(true);
    expect(result.path.some((p) => p.x === 3 && p.y === 5)).toBe(true);
  });
});
