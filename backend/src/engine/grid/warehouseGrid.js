const { isTypeWalkable } = require('./cellTypes');

/**
 * Builds a lookup grid from a warehouse's sparse cell list. Accepts either
 * a Mongoose document or a plain object (e.g. `{ rows, cols, cells }` from
 * a test fixture or the frontend's serializeGrid() output) - anything with
 * that shape works, which keeps this decoupled from Mongoose.
 */
function warehouseToGrid(warehouse) {
  const blocked = new Set();
  const charging = new Set();
  const dock = new Set();
  for (const cell of warehouse.cells || []) {
    const k = `${cell.x}:${cell.y}`;
    if (!isTypeWalkable(cell.type)) blocked.add(k);
    if (cell.type === 'charging') charging.add(k);
    if (cell.type === 'dock') dock.add(k);
  }

  return {
    rows: warehouse.rows,
    cols: warehouse.cols,
    isBlocked(x, y) {
      return blocked.has(`${x}:${y}`);
    },
    isCharging(x, y) {
      return charging.has(`${x}:${y}`);
    },
    isDock(x, y) {
      return dock.has(`${x}:${y}`);
    },
  };
}

module.exports = { warehouseToGrid };
