import { createGrid, setCell, getCell } from './gridEngine.js';
import { CELL_TYPES } from './cellTypes.js';

export const LAYOUT_DENSITIES = {
  sparse: { shelfBlockWidth: 2, shelfBlockDepth: 3, aisleWidth: 3, blockProbability: 0.55 },
  balanced: { shelfBlockWidth: 3, shelfBlockDepth: 4, aisleWidth: 2, blockProbability: 0.75 },
  dense: { shelfBlockWidth: 4, shelfBlockDepth: 5, aisleWidth: 1, blockProbability: 0.9 },
};

/** Inclusive random integer in [min, max]. */
function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Bugfix: this used to be a fully deterministic function of
 * `{ rows, cols, density }` alone - every click of "Generate Layout" at
 * the same grid size and density produced byte-for-byte the same shelf
 * blocks, the same 3 charging stations, the same 2 docks, and never
 * placed a single obstacle. It now actually uses `rng` (defaults to
 * Math.random, overridable for deterministic tests, same pattern as
 * orderGenerator.js): each candidate shelf block is placed or skipped at
 * random (so shelf count/shape varies), the number of charging stations
 * and docks are each randomized within a sensible range, and a random
 * scattering of Obstacle cells is added across whatever floor space is
 * left - something this function never produced at all before.
 */
export function generateWarehouseLayout({
  rows,
  cols,
  density = 'balanced',
  chargingStations,
  docks,
  obstacleDensity,
  rng = Math.random,
} = {}) {
  const { shelfBlockWidth, shelfBlockDepth, aisleWidth, blockProbability } =
    LAYOUT_DENSITIES[density] || LAYOUT_DENSITIES.balanced;

  let grid = createGrid(rows, cols);
  const margin = 1; // keeps a walkway border around the whole floor

  // Reserve the top row for docks and the bottom row for charging stations
  // - shelf blocks fill the space between them.
  const shelfTop = margin + 1;
  const shelfBottom = grid.rows - margin - 1;

  let x = margin + aisleWidth;
  while (x + shelfBlockWidth <= grid.cols - margin) {
    let y = shelfTop + aisleWidth;
    while (y + shelfBlockDepth <= shelfBottom - aisleWidth) {
      // Randomly skip some candidate slots so the shelf layout - and so
      // the total shelf count - actually varies between generations,
      // rather than always filling every slot the same way.
      if (rng() < blockProbability) {
        for (let dx = 0; dx < shelfBlockWidth; dx++) {
          for (let dy = 0; dy < shelfBlockDepth; dy++) {
            grid = setCell(grid, x + dx, y + dy, CELL_TYPES.SHELF);
          }
        }
      }
      y += shelfBlockDepth + aisleWidth;
    }
    x += shelfBlockWidth + aisleWidth;
  }

  const spacedX = (count, index) => margin + Math.round(((index + 1) * (grid.cols - 2 * margin)) / (count + 1));

  const chargingCount = chargingStations ?? randInt(rng, 2, 5);
  for (let i = 0; i < chargingCount; i++) {
    const cx = spacedX(chargingCount, i);
    if (cx >= 0 && cx < grid.cols) grid = setCell(grid, cx, shelfBottom + 1, CELL_TYPES.CHARGING);
  }

  const dockY = 0; // the very top edge - the "entrance" side
  const dockCount = docks ?? randInt(rng, 1, 4);
  for (let i = 0; i < dockCount; i++) {
    const dx = spacedX(dockCount, i);
    if (dx >= 0 && dx < grid.cols) grid = setCell(grid, dx, dockY, CELL_TYPES.DOCK);
  }

  // Scatter a random handful of Obstacle cells across whatever floor space
  // is still empty - previously this generator never placed any at all.
  const emptyCells = [];
  for (let ey = 0; ey < grid.rows; ey++) {
    for (let ex = 0; ex < grid.cols; ex++) {
      if (getCell(grid, ex, ey) === CELL_TYPES.EMPTY) emptyCells.push({ x: ex, y: ey });
    }
  }
  const fraction = obstacleDensity ?? (0.02 + rng() * 0.06); // ~2%-8% of remaining floor space
  const obstacleCount =
    emptyCells.length === 0 ? 0 : Math.max(1, Math.min(emptyCells.length, Math.round(emptyCells.length * fraction)));

  // Partial Fisher-Yates shuffle: pick `obstacleCount` distinct random
  // cells out of `emptyCells` without needing to shuffle the whole array.
  for (let i = 0; i < obstacleCount; i++) {
    const swapIndex = i + Math.floor(rng() * (emptyCells.length - i));
    [emptyCells[i], emptyCells[swapIndex]] = [emptyCells[swapIndex], emptyCells[i]];
    grid = setCell(grid, emptyCells[i].x, emptyCells[i].y, CELL_TYPES.OBSTACLE);
  }

  return grid;
}