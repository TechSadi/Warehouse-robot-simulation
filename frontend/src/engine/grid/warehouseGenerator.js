import { createGrid, setCell } from './gridEngine.js';
import { CELL_TYPES } from './cellTypes.js';

export const LAYOUT_DENSITIES = {
  sparse: { shelfBlockWidth: 2, shelfBlockDepth: 3, aisleWidth: 3 },
  balanced: { shelfBlockWidth: 3, shelfBlockDepth: 4, aisleWidth: 2 },
  dense: { shelfBlockWidth: 4, shelfBlockDepth: 5, aisleWidth: 1 },
};

/**
 * Milestone 13: procedurally generates a plausible warehouse floor plan -
 * repeating blocks of shelving separated by walkway aisles, a handful of
 * charging stations along the bottom edge, and dock cells along the top
 * ("entrance") edge - so demoing a fleet doesn't require hand-painting a
 * grid from scratch every time. Pure and deterministic-shape (no
 * randomness) given the same inputs, so it's easy to reason about and
 * regenerate with different density settings.
 */
export function generateWarehouseLayout({
  rows,
  cols,
  density = 'balanced',
  chargingStations = 3,
  docks = 2,
} = {}) {
  const { shelfBlockWidth, shelfBlockDepth, aisleWidth } = LAYOUT_DENSITIES[density] || LAYOUT_DENSITIES.balanced;

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
      for (let dx = 0; dx < shelfBlockWidth; dx++) {
        for (let dy = 0; dy < shelfBlockDepth; dy++) {
          grid = setCell(grid, x + dx, y + dy, CELL_TYPES.SHELF);
        }
      }
      y += shelfBlockDepth + aisleWidth;
    }
    x += shelfBlockWidth + aisleWidth;
  }

  const spacedX = (count, index) => margin + Math.round(((index + 1) * (grid.cols - 2 * margin)) / (count + 1));

  for (let i = 0; i < chargingStations; i++) {
    const cx = spacedX(chargingStations, i);
    if (cx >= 0 && cx < grid.cols) grid = setCell(grid, cx, shelfBottom + 1, CELL_TYPES.CHARGING);
  }

  const dockY = 0; // the very top edge - the "entrance" side
  for (let i = 0; i < docks; i++) {
    const dx = spacedX(docks, i);
    if (dx >= 0 && dx < grid.cols) grid = setCell(grid, dx, dockY, CELL_TYPES.DOCK);
  }

  return grid;
}
