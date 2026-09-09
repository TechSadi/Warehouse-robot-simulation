import { getCell, isInBounds, BASE_CELL_SIZE } from '../../engine/grid/gridEngine.js';
import { cellColor, CELL_TYPES } from '../../engine/grid/cellTypes.js';
import { THEME } from '../../theme.js';

/**
 * Everything that gets drawn on the floor plan, as pure functions of a
 * scene and a 2D context.
 *
 * This used to live inside `GridCanvas.jsx`, closed over the component's
 * refs, and was the one part of the frontend no test could reach: jsdom
 * has no 2D context and Playwright can only assert that a `<canvas>`
 * element exists, not what was drawn on it. "Rendering regressions are
 * caught by looking" was the honest description of the situation and a bad
 * place to leave the most visually load-bearing code in the app.
 *
 * Separating it does not conjure up a renderer that jsdom can run - that
 * is not a solvable problem here. What it does is make the *drawing
 * decisions* testable independently of the pixels: which cells are visited
 * at all (viewport culling), in what order the layers go down, what colour
 * a robot is for its status, how far round its battery ring goes, which
 * obstacles are skipped as off-screen, how the heatmap normalises. Those
 * are the things that actually break, and a recording stand-in for the
 * context (see tests/helpers/recordingContext.js) checks every one of them
 * without a single pixel being rasterised.
 *
 * What remains uncheckable is the last mile: whether `fillRect` with the
 * right arguments and the right fill style produces the right image. That
 * is a screenshot-diffing problem, and it is the honest residue.
 */

const ROBOT_STATUS_COLOR = {
  idle: THEME.textSecondary,
  moving: THEME.cyan,
  charging: THEME.success,
  error: THEME.danger,
};

const OBSTACLE_TYPE_COLOR = {
  human_worker: THEME.amber,
  temporary_obstacle: THEME.textMuted,
  broken_robot: THEME.danger,
  construction_zone: THEME.cyan,
};

export function batteryColor(percent) {
  if (percent > 50) return THEME.success;
  if (percent > 20) return THEME.amber;
  return THEME.danger;
}

/**
 * Which cells are on screen, given the viewport.
 *
 * Extracted because it is the whole of the culling strategy in four lines,
 * and because "the grid draws every cell it has" is a regression that is
 * invisible on a 20x20 warehouse and fatal on an 80x80 one at high zoom.
 */
export function visibleBounds(grid, { width, height, scale, offsetX, offsetY }) {
  const cellSize = BASE_CELL_SIZE * scale;
  return {
    cellSize,
    startCol: Math.max(0, Math.floor(-offsetX / cellSize)),
    endCol: Math.min(grid.cols - 1, Math.ceil((width - offsetX) / cellSize)),
    startRow: Math.max(0, Math.floor(-offsetY / cellSize)),
    endRow: Math.min(grid.rows - 1, Math.ceil((height - offsetY) / cellSize)),
  };
}

/** A robot: a filled circle colored by status, a short heading tick, and a
 * thin arc around it showing battery level - so status and battery are
 * both readable directly off the floor plan, not just the roster list. */
export function drawRobot(ctx, robot, cellSize) {
  const cx = robot.position.x * cellSize + cellSize / 2;
  const cy = robot.position.y * cellSize + cellSize / 2;
  const radius = cellSize * 0.28;
  const color = ROBOT_STATUS_COLOR[robot.status] || THEME.textSecondary;

  // Battery ring (background track + foreground arc).
  ctx.lineWidth = Math.max(1.5, cellSize * 0.06);
  ctx.strokeStyle = THEME.line;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + ctx.lineWidth, 0, Math.PI * 2);
  ctx.stroke();

  const batteryFraction = Math.max(0, Math.min(1, robot.battery / 100));
  ctx.strokeStyle = batteryColor(robot.battery);
  ctx.beginPath();
  ctx.arc(cx, cy, radius + ctx.lineWidth, -Math.PI / 2, -Math.PI / 2 + batteryFraction * Math.PI * 2);
  ctx.stroke();

  // Body.
  ctx.fillStyle = color;
  ctx.globalAlpha = robot.isWaiting ? 0.5 : 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Heading tick.
  const heading = ((robot.rotation || 0) * Math.PI) / 180;
  ctx.strokeStyle = THEME.bgVoid;
  ctx.lineWidth = Math.max(1.5, cellSize * 0.05);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(heading) * radius, cy + Math.sin(heading) * radius);
  ctx.stroke();
}

/** A dynamic obstacle (Milestone 9's human workers, temporary obstacles,
 * broken-robot markers, and construction zones - synced in real time over
 * Socket.IO as of Milestone 11, and persisted as of the limitations pass):
 * a diagonally-hatched cell tinted by type, distinct from the solid
 * static-grid cell fills above it, so it reads as "temporary" rather than
 * part of the warehouse layout itself. */
export function drawObstacle(ctx, obstacle, cellSize) {
  const color = OBSTACLE_TYPE_COLOR[obstacle.type] || THEME.textMuted;
  for (const cell of obstacle.cells) {
    const px = cell.x * cellSize;
    const py = cell.y * cellSize;

    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, cellSize, cellSize);
    ctx.clip();

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(px, py, cellSize, cellSize);

    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cellSize * 0.06);
    const step = Math.max(4, cellSize * 0.22);
    for (let offset = -cellSize; offset < cellSize * 2; offset += step) {
      ctx.beginPath();
      ctx.moveTo(px + offset, py);
      ctx.lineTo(px + offset + cellSize, py + cellSize);
      ctx.stroke();
    }
    ctx.restore();

    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, cellSize * 0.05);
    ctx.strokeRect(px + 1, py + 1, cellSize - 2, cellSize - 2);
    ctx.globalAlpha = 1;
  }
}

/** Renders one frame of the AI Visualisation Panel (Milestone 12): the
 * open set (frontier, not yet expanded) and closed set (already expanded)
 * from the current step, thin parent-pointer lines showing the search
 * tree, the current node as a bold ring, start/goal markers, and - once
 * found - the final path as a connected line. Drawn after obstacles and
 * before robots, so a live fleet (if any is running at the same time)
 * still reads as the most important thing on screen. */
export function drawPathVisualization(ctx, viz, cellSize) {
  const cellCenter = (x, y) => ({ cx: x * cellSize + cellSize / 2, cy: y * cellSize + cellSize / 2 });

  const step = viz.currentStep;
  if (step) {
    for (const node of step.closedSet) {
      ctx.fillStyle = THEME.textMuted;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(node.x * cellSize, node.y * cellSize, cellSize, cellSize);
    }
    for (const node of step.openSet) {
      ctx.fillStyle = THEME.cyan;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(node.x * cellSize, node.y * cellSize, cellSize, cellSize);
    }
    ctx.globalAlpha = 1;

    // Parent-pointer lines - the search tree so far.
    ctx.strokeStyle = THEME.lineBright;
    ctx.lineWidth = Math.max(1, cellSize * 0.03);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (const node of [...step.closedSet, ...step.openSet]) {
      if (!node.parent) continue;
      const from = cellCenter(node.x, node.y);
      const to = cellCenter(node.parent.x, node.parent.y);
      ctx.moveTo(from.cx, from.cy);
      ctx.lineTo(to.cx, to.cy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current node - a bold ring.
    const { cx, cy } = cellCenter(step.current.x, step.current.y);
    ctx.strokeStyle = THEME.amber;
    ctx.lineWidth = Math.max(1.5, cellSize * 0.08);
    ctx.beginPath();
    ctx.arc(cx, cy, cellSize * 0.32, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Final path - a connected line once the search has found one.
  if (viz.finalPath && viz.finalPath.length > 1) {
    ctx.strokeStyle = THEME.success;
    ctx.lineWidth = Math.max(2, cellSize * 0.1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    viz.finalPath.forEach((node, i) => {
      const { cx, cy } = cellCenter(node.x, node.y);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
  }

  // Start/goal markers - drawn last so they stay visible over everything
  // else, including the final path line passing through them.
  if (viz.start) {
    const { cx, cy } = cellCenter(viz.start.x, viz.start.y);
    ctx.fillStyle = THEME.success;
    ctx.beginPath();
    ctx.arc(cx, cy, cellSize * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  if (viz.goal) {
    const { cx, cy } = cellCenter(viz.goal.x, viz.goal.y);
    ctx.fillStyle = THEME.danger;
    ctx.beginPath();
    ctx.moveTo(cx, cy - cellSize * 0.22);
    ctx.lineTo(cx + cellSize * 0.22, cy);
    ctx.lineTo(cx, cy + cellSize * 0.22);
    ctx.lineTo(cx - cellSize * 0.22, cy);
    ctx.closePath();
    ctx.fill();
  }
}

/** The static layout: one filled square per non-empty cell, within the
 * viewport only. Empty cells are left to the background. */
export function drawCells(ctx, grid, bounds) {
  const { cellSize, startCol, endCol, startRow, endRow } = bounds;
  for (let y = startRow; y <= endRow; y++) {
    for (let x = startCol; x <= endCol; x++) {
      const type = getCell(grid, x, y);
      if (type !== CELL_TYPES.EMPTY) {
        ctx.fillStyle = cellColor(type);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        ctx.globalAlpha = 1;
      }
    }
  }
}

/**
 * Traffic density, normalised against the busiest cell in the *whole*
 * heatmap rather than the visible part of it.
 *
 * That matters: normalising against what happens to be on screen would
 * make the same cell change shade as the user pans, which reads as the
 * data changing when only the viewport did.
 */
export function drawHeatmap(ctx, heatmap, bounds) {
  const { cellSize, startCol, endCol, startRow, endRow } = bounds;
  if (!heatmap || heatmap.size === 0) return;

  let maxVisits = 1;
  for (const count of heatmap.values()) maxVisits = Math.max(maxVisits, count);
  for (const [key, count] of heatmap) {
    const [hx, hy] = key.split(':').map(Number);
    if (hx < startCol || hx > endCol || hy < startRow || hy > endRow) continue;
    ctx.fillStyle = THEME.amber;
    ctx.globalAlpha = 0.15 + 0.55 * (count / maxVisits);
    ctx.fillRect(hx * cellSize, hy * cellSize, cellSize, cellSize);
    ctx.globalAlpha = 1;
  }
}

/** Grid lines, as one path rather than one stroke per line - an 80x80 grid
 * is 162 lines, and 162 `stroke()` calls per frame at 60fps is the kind of
 * thing that shows up on a mid-range laptop. */
export function drawGridLines(ctx, bounds) {
  const { cellSize, startCol, endCol, startRow, endRow } = bounds;
  if (startCol > endCol || startRow > endRow) return;

  ctx.strokeStyle = THEME.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startCol; x <= endCol + 1; x++) {
    // The half-pixel offset puts a 1px line on a pixel boundary rather
    // than straddling two, which is the difference between a crisp line
    // and a grey smear.
    ctx.moveTo(x * cellSize + 0.5, startRow * cellSize);
    ctx.lineTo(x * cellSize + 0.5, (endRow + 1) * cellSize);
  }
  for (let y = startRow; y <= endRow + 1; y++) {
    ctx.moveTo(startCol * cellSize, y * cellSize + 0.5);
    ctx.lineTo((endCol + 1) * cellSize, y * cellSize + 0.5);
  }
  ctx.stroke();
}

/** The hovered and selected cell outlines. */
export function drawCellHighlights(ctx, grid, { hovered, selected }, bounds) {
  const { cellSize } = bounds;
  if (hovered && isInBounds(grid, hovered.x, hovered.y)) {
    ctx.strokeStyle = THEME.cyan;
    ctx.lineWidth = 2;
    ctx.strokeRect(hovered.x * cellSize + 1, hovered.y * cellSize + 1, cellSize - 2, cellSize - 2);
  }
  if (selected && isInBounds(grid, selected.x, selected.y)) {
    ctx.strokeStyle = THEME.amber;
    ctx.lineWidth = 2;
    ctx.strokeRect(selected.x * cellSize + 1, selected.y * cellSize + 1, cellSize - 2, cellSize - 2);
  }
}

/**
 * One whole frame.
 *
 * The layer order is the substance of this function and is deliberate:
 * background, static cells, heatmap, grid lines, highlights, obstacles,
 * the A* overlay, then robots. Robots go last because a live fleet is the
 * thing the operator is watching, and the search overlay goes under them
 * because it is context rather than subject.
 *
 * @param {any} ctx a CanvasRenderingContext2D, or anything with its shape
 * @param {any} scene
 */
export function renderScene(ctx, scene) {
  const {
    grid,
    width,
    height,
    dpr = 1,
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    robots = [],
    obstacles = [],
    heatmap = null,
    showHeatmap = false,
    pathVisualization = null,
    hoveredCell = null,
    selectedCell = null,
  } = scene;

  const bounds = visibleBounds(grid, { width, height, scale, offsetX, offsetY });

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = THEME.bgVoid;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(offsetX, offsetY);

  drawCells(ctx, grid, bounds);
  if (showHeatmap) drawHeatmap(ctx, heatmap, bounds);
  drawGridLines(ctx, bounds);
  drawCellHighlights(ctx, grid, { hovered: hoveredCell, selected: selectedCell }, bounds);

  for (const obstacle of obstacles) {
    // An obstacle can span many cells, so it is drawn if *any* of them is
    // on screen - culling per obstacle rather than per cell keeps a zone
    // that runs off the edge of the viewport from disappearing entirely.
    const inView = obstacle.cells.some(
      (c) =>
        c.x >= bounds.startCol &&
        c.x <= bounds.endCol &&
        c.y >= bounds.startRow &&
        c.y <= bounds.endRow
    );
    if (inView) drawObstacle(ctx, obstacle, bounds.cellSize);
  }

  if (pathVisualization) drawPathVisualization(ctx, pathVisualization, bounds.cellSize);

  for (const robot of robots) drawRobot(ctx, robot, bounds.cellSize);

  ctx.restore();
  return bounds;
}
