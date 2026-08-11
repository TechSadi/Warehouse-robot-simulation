import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { getCell, isInBounds, BASE_CELL_SIZE } from '../../engine/grid/gridEngine.js';
import { cellColor, CELL_TYPES } from '../../engine/grid/cellTypes.js';
import { THEME } from '../../theme.js';
import './GridCanvas.css';

const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
const DRAG_THRESHOLD_PX = 4;

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

function batteryColor(percent) {
  if (percent > 50) return THEME.success;
  if (percent > 20) return THEME.amber;
  return THEME.danger;
}

/** A robot: a filled circle colored by status, a short heading tick, and a
 * thin arc around it showing battery level - so status and battery are
 * both readable directly off the floor plan, not just the roster list. */
function drawRobot(ctx, robot, cellSize) {
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

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A dynamic obstacle (Milestone 9's human workers, temporary obstacles,
 * broken-robot markers, and construction zones - now synced in real time
 * over Socket.IO as of Milestone 11): a diagonally-hatched cell tinted by
 * type, distinct from the solid static-grid cell fills above it, so it
 * reads as "temporary" rather than part of the warehouse layout itself. */
function drawObstacle(ctx, obstacle, cellSize) {
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
function drawPathVisualization(ctx, viz, cellSize) {
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

const GridCanvas = forwardRef(function GridCanvas(
  {
    grid,
    selectedCell,
    hoveredCell,
    isPaintTool,
    robots,
    heatmap,
    showHeatmap,
    obstacles,
    pathVisualization,
    onHoverChange,
    onCellClick,
    onCellPaint,
    onCellErase,
    onZoomChange,
  },
  ref
) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const viewportRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const gridRef = useRef(grid);
  const selectedRef = useRef(selectedCell);
  const hoveredRef = useRef(hoveredCell);
  const isPaintToolRef = useRef(isPaintTool);
  const robotsRef = useRef(robots || []);
  const heatmapRef = useRef(heatmap || new Map());
  const showHeatmapRef = useRef(Boolean(showHeatmap));
  const obstaclesRef = useRef(obstacles || []);
  const pathVisualizationRef = useRef(pathVisualization || null);
  const drawScheduled = useRef(false);
  const hasCenteredOnce = useRef(false);
  const pointerState = useRef({
    down: false,
    dragging: false,
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    lastPaintedKey: null,
  });
  const spacePressed = useRef(false);

  gridRef.current = grid;
  selectedRef.current = selectedCell;
  hoveredRef.current = hoveredCell;
  isPaintToolRef.current = isPaintTool;
  robotsRef.current = robots || [];
  heatmapRef.current = heatmap || new Map();
  showHeatmapRef.current = Boolean(showHeatmap);
  obstaclesRef.current = obstacles || [];
  pathVisualizationRef.current = pathVisualization || null;

  const scheduleDraw = useCallback(() => {
    if (drawScheduled.current) return;
    drawScheduled.current = true;
    requestAnimationFrame(() => {
      drawScheduled.current = false;
      draw();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { width, height, dpr } = sizeRef.current;
    const { scale, offsetX, offsetY } = viewportRef.current;
    const g = gridRef.current;
    const cellSize = BASE_CELL_SIZE * scale;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = THEME.bgVoid;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(offsetX, offsetY);

    const startCol = Math.max(0, Math.floor(-offsetX / cellSize));
    const endCol = Math.min(g.cols - 1, Math.ceil((width - offsetX) / cellSize));
    const startRow = Math.max(0, Math.floor(-offsetY / cellSize));
    const endRow = Math.min(g.rows - 1, Math.ceil((height - offsetY) / cellSize));

    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const type = getCell(g, x, y);
        if (type !== CELL_TYPES.EMPTY) {
          ctx.fillStyle = cellColor(type);
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
          ctx.globalAlpha = 1;
        }
      }
    }

    if (showHeatmapRef.current && heatmapRef.current.size > 0) {
      let maxVisits = 1;
      for (const count of heatmapRef.current.values()) maxVisits = Math.max(maxVisits, count);
      for (const [key, count] of heatmapRef.current) {
        const [hx, hy] = key.split(':').map(Number);
        if (hx < startCol || hx > endCol || hy < startRow || hy > endRow) continue;
        ctx.fillStyle = THEME.amber;
        ctx.globalAlpha = 0.15 + 0.55 * (count / maxVisits);
        ctx.fillRect(hx * cellSize, hy * cellSize, cellSize, cellSize);
        ctx.globalAlpha = 1;
      }
    }

    if (startCol <= endCol && startRow <= endRow) {
      ctx.strokeStyle = THEME.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = startCol; x <= endCol + 1; x++) {
        ctx.moveTo(x * cellSize + 0.5, startRow * cellSize);
        ctx.lineTo(x * cellSize + 0.5, (endRow + 1) * cellSize);
      }
      for (let y = startRow; y <= endRow + 1; y++) {
        ctx.moveTo(startCol * cellSize, y * cellSize + 0.5);
        ctx.lineTo((endCol + 1) * cellSize, y * cellSize + 0.5);
      }
      ctx.stroke();
    }

    const hover = hoveredRef.current;
    if (hover && isInBounds(g, hover.x, hover.y)) {
      ctx.strokeStyle = THEME.cyan;
      ctx.lineWidth = 2;
      ctx.strokeRect(hover.x * cellSize + 1, hover.y * cellSize + 1, cellSize - 2, cellSize - 2);
    }

    const sel = selectedRef.current;
    if (sel && isInBounds(g, sel.x, sel.y)) {
      ctx.strokeStyle = THEME.amber;
      ctx.lineWidth = 2;
      ctx.strokeRect(sel.x * cellSize + 1, sel.y * cellSize + 1, cellSize - 2, cellSize - 2);
    }

    for (const obstacle of obstaclesRef.current) {
      const inView = obstacle.cells.some(
        (c) => c.x >= startCol && c.x <= endCol && c.y >= startRow && c.y <= endRow
      );
      if (inView) drawObstacle(ctx, obstacle, cellSize);
    }

    if (pathVisualizationRef.current) {
      drawPathVisualization(ctx, pathVisualizationRef.current, cellSize);
    }

    for (const robot of robotsRef.current) {
      drawRobot(ctx, robot, cellSize);
    }

    ctx.restore();
  }

  const centerGrid = useCallback(() => {
    const { width, height } = sizeRef.current;
    const { scale } = viewportRef.current;
    const gridWidth = gridRef.current.cols * BASE_CELL_SIZE * scale;
    const gridHeight = gridRef.current.rows * BASE_CELL_SIZE * scale;
    viewportRef.current = {
      scale,
      offsetX: Math.max(0, (width - gridWidth) / 2),
      offsetY: Math.max(0, (height - gridHeight) / 2),
    };
    scheduleDraw();
  }, [scheduleDraw]);

  const resetView = useCallback(() => {
    viewportRef.current = { scale: 1, offsetX: 0, offsetY: 0 };
    centerGrid();
    onZoomChange?.(1);
  }, [centerGrid, onZoomChange]);

  function zoomAtPoint(factor, pointX, pointY) {
    const { scale, offsetX, offsetY } = viewportRef.current;
    const newScale = clampScale(scale * factor);
    if (newScale === scale) return;
    const worldX = (pointX - offsetX) / scale;
    const worldY = (pointY - offsetY) / scale;
    viewportRef.current = {
      scale: newScale,
      offsetX: pointX - worldX * newScale,
      offsetY: pointY - worldY * newScale,
    };
    scheduleDraw();
    onZoomChange?.(newScale);
  }

  const zoomBy = useCallback((factor) => {
    const { width, height } = sizeRef.current;
    zoomAtPoint(factor, width / 2, height / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({ resetView, zoomBy }), [resetView, zoomBy]);

  function screenToGrid(px, py) {
    const { scale, offsetX, offsetY } = viewportRef.current;
    const cellSize = BASE_CELL_SIZE * scale;
    return { x: Math.floor((px - offsetX) / cellSize), y: Math.floor((py - offsetY) / cellSize) };
  }

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width, height, dpr };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (!hasCenteredOnce.current && width > 0 && height > 0) {
        hasCenteredOnce.current = true;
        centerGrid();
      }
      scheduleDraw();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [centerGrid, scheduleDraw]);

  const gridDimsKey = `${grid.rows}x${grid.cols}`;
  useEffect(() => {
    if (hasCenteredOnce.current) centerGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridDimsKey]);

  useEffect(() => {
    scheduleDraw();
  }, [grid, selectedCell, hoveredCell, robots, heatmap, showHeatmap, obstacles, pathVisualization, scheduleDraw]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.code === 'Space') spacePressed.current = true;
    }
    function onKeyUp(e) {
      if (e.code === 'Space') spacePressed.current = false;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  function handlePointerDown(e) {
    canvasRef.current.setPointerCapture(e.pointerId);
    pointerState.current = {
      down: true,
      dragging: false,
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: viewportRef.current.offsetX,
      startOffsetY: viewportRef.current.offsetY,
      lastPaintedKey: null,
    };
  }

  function handlePointerMove(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const state = pointerState.current;

    if (state.down) {
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (!state.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        state.dragging = true;
      }

      if (state.dragging) {
        const shouldPan = spacePressed.current || !isPaintToolRef.current;
        if (shouldPan) {
          viewportRef.current = {
            ...viewportRef.current,
            offsetX: state.startOffsetX + dx,
            offsetY: state.startOffsetY + dy,
          };
          scheduleDraw();
        } else {
          const cell = screenToGrid(px, py);
          const key = `${cell.x}:${cell.y}`;
          if (key !== state.lastPaintedKey) {
            state.lastPaintedKey = key;
            onCellPaint(cell.x, cell.y);
          }
        }
        return;
      }
    }

    const cell = screenToGrid(px, py);
    const prev = hoveredRef.current;
    if (!prev || prev.x !== cell.x || prev.y !== cell.y) {
      onHoverChange(cell);
    }
  }

  function handlePointerUp(e) {
    const state = pointerState.current;
    const wasDragging = state.dragging;
    pointerState.current.down = false;
    pointerState.current.dragging = false;

    if (!wasDragging) {
      const rect = canvasRef.current.getBoundingClientRect();
      const cell = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
      if (isInBounds(gridRef.current, cell.x, cell.y)) {
        onCellClick(cell.x, cell.y);
      }
    }
  }

  function handlePointerLeave() {
    onHoverChange(null);
  }

  function handleContextMenu(e) {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const cell = screenToGrid(e.clientX - rect.left, e.clientY - rect.top);
    if (isInBounds(gridRef.current, cell.x, cell.y)) {
      onCellErase(cell.x, cell.y);
    }
  }

  // React registers onWheel as a passive listener, so e.preventDefault() in
  // a synthetic handler silently fails to stop page scroll. Attaching the
  // listener natively with { passive: false } is the only way to actually
  // suppress scroll while zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    function handleWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAtPoint(factor, e.clientX - rect.left, e.clientY - rect.top);
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, []);

  return (
    <div className="grid-canvas" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
});

export default GridCanvas;
