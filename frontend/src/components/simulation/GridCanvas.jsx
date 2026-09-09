import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { isInBounds, BASE_CELL_SIZE } from '../../engine/grid/gridEngine.js';
import { renderScene } from './renderScene.js';
import './GridCanvas.css';

const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
const DRAG_THRESHOLD_PX = 4;

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The floor plan itself: a single canvas that draws the grid, the fleet, the
 * dynamic obstacles and the A* trace, with pan/zoom and both pointer and
 * keyboard editing.
 *
 * Props are read through refs rather than closed over, so a robot update
 * twice a second schedules one animation frame instead of re-creating every
 * handler on the element.
 *
 * @param {any} props
 * @param {any} ref
 */
const GridCanvas = forwardRef(function GridCanvas(/** @type {any} */ props, ref) {
  const {
    grid,
    selectedCell,
    hoveredCell,
    isPaintTool,
    robots,
    heatmap,
    heatmapEpoch,
    showHeatmap,
    obstacles,
    pathVisualization,
    onHoverChange,
    onCellClick,
    onCellPaint,
    onCellErase,
    onZoomChange,
    onMoveSelection,
    gridLabel,
  } = props;
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

  /**
   * One frame.
   *
   * Everything this used to do inline now lives in `renderScene.js` as
   * pure functions of a scene object. That is not tidying: it is the only
   * way any of it becomes testable at all. jsdom has no 2D context and
   * Playwright can only assert that a canvas element exists, so drawing
   * logic embedded in this component was - by construction - the one part
   * of the frontend no test could reach. Handing a plain object to a
   * function lets a recording stand-in for the context verify the
   * decisions (what is culled, what order the layers go down, what colour
   * a robot is for its status) without rasterising anything.
   *
   * This function keeps exactly one job: turn the component's refs into
   * that object.
   */
  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, dpr } = sizeRef.current;
    const { scale, offsetX, offsetY } = viewportRef.current;

    renderScene(ctx, {
      grid: gridRef.current,
      width,
      height,
      dpr,
      scale,
      offsetX,
      offsetY,
      robots: robotsRef.current,
      obstacles: obstaclesRef.current,
      heatmap: heatmapRef.current,
      showHeatmap: showHeatmapRef.current,
      pathVisualization: pathVisualizationRef.current,
      hoveredCell: hoveredRef.current,
      selectedCell: selectedRef.current,
    });
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

  // The heatmap Map is mutated in place by useLiveSimulation rather than
  // replaced (copying it on every tick was pure garbage), so its identity is
  // not a useful dependency. Robot movement is what fills it, and `robots`
  // below already covers that; `heatmapEpoch` covers the one case robot
  // updates do not - the user clearing it.
  useEffect(() => {
    scheduleDraw();
  }, [
    grid,
    selectedCell,
    hoveredCell,
    robots,
    heatmapEpoch,
    showHeatmap,
    obstacles,
    pathVisualization,
    scheduleDraw,
  ]);

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

  /**
   * Keyboard equivalents for the pointer interactions.
   *
   * A canvas has no per-cell DOM for the browser to focus, so every editing
   * action here - selecting a cell, placing an object, erasing one - used
   * to require a mouse. Arrow keys move the selection, Enter applies the
   * active tool to it, Delete clears it. The selection ring the pointer
   * already drew doubles as the keyboard cursor, so there is nothing new
   * to learn and nothing extra to render.
   *
   * Space is deliberately not bound: it is already hold-to-pan.
   */
  function handleKeyDown(e) {
    const sel = selectedRef.current;

    const step = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (step) {
      e.preventDefault();
      onMoveSelection?.(step[0], step[1]);
      return;
    }

    if (e.key === 'Enter' && sel) {
      e.preventDefault();
      onCellClick(sel.x, sel.y);
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault();
      onCellErase(sel.x, sel.y);
    }
  }

  return (
    <div className="grid-canvas" ref={containerRef}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label={
          gridLabel ||
          'Warehouse grid. Arrow keys move the selected cell, Enter places the active tool, Delete clears it.'
        }
        onKeyDown={handleKeyDown}
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
