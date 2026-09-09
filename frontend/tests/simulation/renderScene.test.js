import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderScene,
  visibleBounds,
  drawRobot,
  drawObstacle,
  drawPathVisualization,
  drawHeatmap,
  drawGridLines,
  batteryColor,
} from '../../src/components/simulation/renderScene.js';
import { createGrid, setCell, BASE_CELL_SIZE } from '../../src/engine/grid/gridEngine.js';
import { CELL_TYPES, cellColor } from '../../src/engine/grid/cellTypes.js';
import { THEME } from '../../src/theme.js';
import { createRecordingContext } from '../helpers/recordingContext.js';

/**
 * The canvas layer, which the architecture notes described as "caught by
 * looking" rather than by CI.
 *
 * These tests do not rasterise anything - that is not possible in jsdom
 * and pretending otherwise would be worse than the gap. What they check is
 * the layer of decisions above the pixels, which is where the regressions
 * that matter actually live: what gets culled, what order the layers go
 * down, what colour a robot is for its status, how far round its battery
 * ring goes, how the heatmap normalises.
 */
let ctx;

beforeEach(() => {
  ctx = createRecordingContext();
});

function scene(overrides = {}) {
  return {
    grid: createGrid(20, 20),
    width: 800,
    height: 600,
    dpr: 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    robots: [],
    obstacles: [],
    heatmap: null,
    showHeatmap: false,
    pathVisualization: null,
    hoveredCell: null,
    selectedCell: null,
    ...overrides,
  };
}

function robot(overrides = {}) {
  return {
    id: 'r1',
    name: 'R1',
    position: { x: 2, y: 3 },
    rotation: 0,
    battery: 100,
    status: 'idle',
    isWaiting: false,
    ...overrides,
  };
}

describe('viewport culling', () => {
  it('covers the whole grid when it fits on screen', () => {
    const grid = createGrid(10, 10);
    const bounds = visibleBounds(grid, {
      width: 10 * BASE_CELL_SIZE,
      height: 10 * BASE_CELL_SIZE,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });

    expect(bounds).toMatchObject({ startCol: 0, startRow: 0, endCol: 9, endRow: 9 });
  });

  it('narrows to what is on screen when the grid is larger than the viewport', () => {
    // The point of culling: an 80x80 warehouse at high zoom must not draw
    // 6400 cells to show 40 of them.
    const grid = createGrid(80, 80);
    const bounds = visibleBounds(grid, {
      width: 200,
      height: 200,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });

    expect(bounds.endCol).toBeLessThan(20);
    expect(bounds.endRow).toBeLessThan(20);
  });

  it('follows the viewport when panned', () => {
    const grid = createGrid(80, 80);
    const bounds = visibleBounds(grid, {
      width: 200,
      height: 200,
      scale: 1,
      offsetX: -BASE_CELL_SIZE * 30,
      offsetY: -BASE_CELL_SIZE * 20,
    });

    expect(bounds.startCol).toBe(30);
    expect(bounds.startRow).toBe(20);
  });

  it('never produces a negative start, however far the viewport is pushed', () => {
    const bounds = visibleBounds(createGrid(20, 20), {
      width: 800,
      height: 600,
      scale: 1,
      offsetX: 5000,
      offsetY: 5000,
    });

    expect(bounds.startCol).toBe(0);
    expect(bounds.startRow).toBe(0);
  });

  it('draws only the cells inside the viewport', () => {
    // Regression guard on the culling itself, from the outside: the
    // difference between "draws what you can see" and "draws everything"
    // is invisible on a small grid and fatal on a large one.
    // setCell is immutable, so the filled grid is the value it returns.
    let grid = createGrid(80, 80);
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) grid = setCell(grid, x, y, CELL_TYPES.SHELF);
    }

    renderScene(ctx, scene({ grid, width: 200, height: 200 }));

    const shelfFills = ctx
      .__callsTo('fillRect')
      .filter((c) => c.state.fillStyle === cellColor(CELL_TYPES.SHELF));
    expect(shelfFills.length).toBeGreaterThan(0);
    expect(shelfFills.length).toBeLessThan(200); // not 6400
  });
});

describe('the static layout', () => {
  it('fills a cell in its own type colour', () => {
    const grid = setCell(createGrid(10, 10), 2, 3, CELL_TYPES.CHARGING);

    renderScene(ctx, scene({ grid }));

    const fill = ctx
      .__callsTo('fillRect')
      .find((c) => c.args[0] === 2 * BASE_CELL_SIZE && c.args[1] === 3 * BASE_CELL_SIZE);
    expect(fill.state.fillStyle).toBe(cellColor(CELL_TYPES.CHARGING));
  });

  it('leaves empty cells to the background', () => {
    const grid = setCell(createGrid(10, 10), 0, 0, CELL_TYPES.SHELF);

    renderScene(ctx, scene({ grid }));

    // One background fill for the whole canvas, plus exactly one cell.
    const fills = ctx.__callsTo('fillRect');
    expect(fills).toHaveLength(2);
    expect(fills[0].state.fillStyle).toBe(THEME.bgVoid);
  });

  it('scales cell geometry with the zoom level', () => {
    const grid = setCell(createGrid(10, 10), 1, 1, CELL_TYPES.SHELF);

    renderScene(ctx, scene({ grid, scale: 2 }));

    const fill = ctx.__callsTo('fillRect').find((c) => c.state.fillStyle === cellColor(CELL_TYPES.SHELF));
    expect(fill.args[2]).toBe(BASE_CELL_SIZE * 2);
  });
});

describe('robots', () => {
  it('colours the body by status', () => {
    const cases = [
      ['idle', THEME.textSecondary],
      ['moving', THEME.cyan],
      ['charging', THEME.success],
      ['error', THEME.danger],
    ];

    for (const [status, expected] of cases) {
      const local = createRecordingContext();
      drawRobot(local, robot({ status }), BASE_CELL_SIZE);
      const body = local.__callsTo('fill')[0];
      expect(body.state.fillStyle).toBe(expected);
    }
  });

  it('falls back to a neutral colour for a status it does not know', () => {
    // Robot status comes from the server, whose shape this client does not
    // control - an unknown value must render, not throw.
    drawRobot(ctx, robot({ status: 'teleporting' }), BASE_CELL_SIZE);
    expect(ctx.__callsTo('fill')[0].state.fillStyle).toBe(THEME.textSecondary);
  });

  it('draws the battery ring proportional to charge', () => {
    const full = createRecordingContext();
    drawRobot(full, robot({ battery: 100 }), BASE_CELL_SIZE);
    const half = createRecordingContext();
    drawRobot(half, robot({ battery: 50 }), BASE_CELL_SIZE);

    // The second arc is the foreground battery arc; its sweep is the
    // fraction of charge remaining.
    const sweep = (rec) => {
      const [, , , start, end] = rec.__callsTo('arc')[1].args;
      return end - start;
    };
    expect(sweep(full)).toBeCloseTo(Math.PI * 2, 5);
    expect(sweep(half)).toBeCloseTo(Math.PI, 5);
  });

  it('clamps a battery reading outside 0-100 rather than over-sweeping the ring', () => {
    for (const battery of [-10, 250]) {
      const local = createRecordingContext();
      drawRobot(local, robot({ battery }), BASE_CELL_SIZE);
      const [, , , start, end] = local.__callsTo('arc')[1].args;
      expect(end - start).toBeGreaterThanOrEqual(0);
      expect(end - start).toBeLessThanOrEqual(Math.PI * 2 + 1e-9);
    }
  });

  it('warns through the ring colour as charge drops', () => {
    expect(batteryColor(80)).toBe(THEME.success);
    expect(batteryColor(35)).toBe(THEME.amber);
    expect(batteryColor(10)).toBe(THEME.danger);
  });

  it('fades a robot that is waiting on a blocked cell', () => {
    const waiting = createRecordingContext();
    drawRobot(waiting, robot({ isWaiting: true }), BASE_CELL_SIZE);
    expect(waiting.__callsTo('fill')[0].state.globalAlpha).toBe(0.5);

    const moving = createRecordingContext();
    drawRobot(moving, robot({ isWaiting: false }), BASE_CELL_SIZE);
    expect(moving.__callsTo('fill')[0].state.globalAlpha).toBe(1);
  });

  it('restores full opacity afterwards, so the next robot is not faded too', () => {
    drawRobot(ctx, robot({ isWaiting: true }), BASE_CELL_SIZE);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('points the heading tick where the robot is facing', () => {
    // Screen space: 0 is east, 90 south.
    const east = createRecordingContext();
    drawRobot(east, robot({ rotation: 0, position: { x: 0, y: 0 } }), 100);
    const [ex] = east.__callsTo('lineTo')[0].args;
    expect(ex).toBeGreaterThan(50);

    const south = createRecordingContext();
    drawRobot(south, robot({ rotation: 90, position: { x: 0, y: 0 } }), 100);
    const [, sy] = south.__callsTo('lineTo')[0].args;
    expect(sy).toBeGreaterThan(50);
  });

  it('draws at a fractional position mid-move rather than snapping to a cell', () => {
    // Interpolated positions are what makes the live view smooth; rounding
    // here would make every robot judder between cells.
    drawRobot(ctx, robot({ position: { x: 2.5, y: 3 } }), 100);
    const [cx] = ctx.__callsTo('arc')[0].args;
    expect(cx).toBe(2.5 * 100 + 50);
  });
});

describe('dynamic obstacles', () => {
  const obstacle = (overrides = {}) => ({
    id: 'o1',
    type: 'human_worker',
    cells: [{ x: 1, y: 1 }],
    ...overrides,
  });

  it('tints by type', () => {
    const cases = [
      ['human_worker', THEME.amber],
      ['temporary_obstacle', THEME.textMuted],
      ['broken_robot', THEME.danger],
      ['construction_zone', THEME.cyan],
    ];

    for (const [type, expected] of cases) {
      const local = createRecordingContext();
      drawObstacle(local, obstacle({ type }), BASE_CELL_SIZE);
      expect(local.__callsTo('fillRect')[0].state.fillStyle).toBe(expected);
    }
  });

  it('hatches the cell, and clips the hatching to it', () => {
    // Without the clip the diagonal strokes run into neighbouring cells,
    // which is how a single worker ends up looking like a wall.
    drawObstacle(ctx, obstacle(), BASE_CELL_SIZE);
    expect(ctx.__callsTo('clip')).toHaveLength(1);
    expect(ctx.__callsTo('stroke').length).toBeGreaterThan(1);
    expect(ctx.__firstIndexOf('clip')).toBeLessThan(ctx.__firstIndexOf('stroke'));
    expect(ctx.__callsTo('restore')).toHaveLength(1);
  });

  it('draws every cell of a multi-cell zone', () => {
    const cells = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ];
    drawObstacle(ctx, obstacle({ type: 'construction_zone', cells }), BASE_CELL_SIZE);
    expect(ctx.__callsTo('clip')).toHaveLength(3);
  });

  it('is drawn when any one of its cells is on screen', () => {
    // Culling per obstacle rather than per cell, so a zone running off the
    // edge of the viewport does not disappear entirely.
    const grid = createGrid(80, 80);
    const straddling = obstacle({
      type: 'construction_zone',
      cells: [
        { x: 1, y: 1 },
        { x: 70, y: 70 },
      ],
    });

    renderScene(ctx, scene({ grid, width: 200, height: 200, obstacles: [straddling] }));
    expect(ctx.__callsTo('clip').length).toBeGreaterThan(0);
  });

  it('is skipped entirely when none of its cells are on screen', () => {
    const grid = createGrid(80, 80);
    const offscreen = obstacle({ cells: [{ x: 70, y: 70 }] });

    renderScene(ctx, scene({ grid, width: 200, height: 200, obstacles: [offscreen] }));
    expect(ctx.__callsTo('clip')).toHaveLength(0);
  });
});

describe('the heatmap', () => {
  const bounds = { cellSize: BASE_CELL_SIZE, startCol: 0, endCol: 19, startRow: 0, endRow: 19 };

  it('normalises against the busiest cell in the whole map', () => {
    // Not against the busiest *visible* cell: the same cell changing shade
    // as the user pans reads as the data changing when only the viewport
    // did.
    const heatmap = new Map([
      ['1:1', 10],
      ['2:2', 5],
    ]);
    drawHeatmap(ctx, heatmap, bounds);

    const [hottest, cooler] = ctx.__callsTo('fillRect');
    expect(hottest.state.globalAlpha).toBeCloseTo(0.7, 5); // 0.15 + 0.55 * 1
    expect(cooler.state.globalAlpha).toBeCloseTo(0.425, 5); // 0.15 + 0.55 * 0.5
  });

  it('skips cells outside the viewport', () => {
    const heatmap = new Map([
      ['1:1', 3],
      ['50:50', 9],
    ]);
    drawHeatmap(ctx, heatmap, { ...bounds, endCol: 5, endRow: 5 });
    expect(ctx.__callsTo('fillRect')).toHaveLength(1);
  });

  it('draws nothing for an empty map', () => {
    drawHeatmap(ctx, new Map(), bounds);
    drawHeatmap(ctx, null, bounds);
    expect(ctx.__callsTo('fillRect')).toHaveLength(0);
  });

  it('is only drawn when the toggle is on', () => {
    const heatmap = new Map([['1:1', 4]]);

    const off = createRecordingContext();
    renderScene(off, scene({ heatmap, showHeatmap: false }));
    const on = createRecordingContext();
    renderScene(on, scene({ heatmap, showHeatmap: true }));

    expect(on.__callsTo('fillRect').length).toBeGreaterThan(off.__callsTo('fillRect').length);
  });
});

describe('grid lines', () => {
  it('draws them as one path rather than one stroke per line', () => {
    // An 80x80 grid is 162 lines; 162 stroke() calls per frame at 60fps is
    // the kind of thing that shows up on a mid-range laptop.
    drawGridLines(ctx, { cellSize: BASE_CELL_SIZE, startCol: 0, endCol: 79, startRow: 0, endRow: 79 });
    expect(ctx.__callsTo('stroke')).toHaveLength(1);
    expect(ctx.__callsTo('moveTo').length).toBe(162);
  });

  it('offsets by half a pixel so a 1px line lands on a pixel boundary', () => {
    drawGridLines(ctx, { cellSize: 10, startCol: 0, endCol: 2, startRow: 0, endRow: 2 });
    const [x] = ctx.__callsTo('moveTo')[0].args;
    expect(x % 1).toBe(0.5);
  });

  it('draws nothing when the viewport contains no cells', () => {
    drawGridLines(ctx, { cellSize: 10, startCol: 5, endCol: 4, startRow: 0, endRow: 0 });
    expect(ctx.__callsTo('stroke')).toHaveLength(0);
  });
});

describe('the A* overlay', () => {
  const viz = (overrides = {}) => ({
    currentStep: {
      openSet: [{ x: 2, y: 0 }],
      closedSet: [{ x: 0, y: 0, parent: { x: 1, y: 0 } }],
      current: { x: 1, y: 0 },
    },
    finalPath: null,
    start: { x: 0, y: 0 },
    goal: { x: 5, y: 5 },
    ...overrides,
  });

  it('distinguishes the open set from the closed set', () => {
    drawPathVisualization(ctx, viz(), BASE_CELL_SIZE);
    const colors = ctx.__callsTo('fillRect').map((c) => c.state.fillStyle);
    expect(colors).toContain(THEME.textMuted); // closed - already expanded
    expect(colors).toContain(THEME.cyan); // open - the frontier
  });

  it('draws the search tree from parent pointers, in one path', () => {
    drawPathVisualization(ctx, viz(), BASE_CELL_SIZE);
    // One lineTo for the single node that has a parent.
    expect(ctx.__callsTo('lineTo').length).toBeGreaterThanOrEqual(1);
  });

  it('marks start and goal distinguishably', () => {
    drawPathVisualization(ctx, viz(), BASE_CELL_SIZE);
    const fills = ctx.__callsTo('fill').map((c) => c.state.fillStyle);
    expect(fills).toContain(THEME.success); // start
    expect(fills).toContain(THEME.danger); // goal
  });

  it('draws the found path as one connected line', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    // start/goal cleared: the goal marker is a diamond, drawn with its own
    // moveTo/lineTo pair, which would be counted below.
    drawPathVisualization(
      ctx,
      viz({ currentStep: null, finalPath: path, start: null, goal: null }),
      BASE_CELL_SIZE
    );

    const pathStroke = ctx.__callsTo('stroke').find((c) => c.state.strokeStyle === THEME.success);
    expect(pathStroke).toBeDefined();
    expect(ctx.__callsTo('moveTo')).toHaveLength(1);
    expect(ctx.__callsTo('lineTo')).toHaveLength(2);
  });

  it('does not draw a "path" of one node', () => {
    drawPathVisualization(
      ctx,
      viz({ currentStep: null, finalPath: [{ x: 0, y: 0 }], start: null, goal: null }),
      BASE_CELL_SIZE
    );
    expect(ctx.__callsTo('stroke')).toHaveLength(0);
  });

  it('renders a step-less visualization without throwing', () => {
    // Before the first step is scrubbed to, there is a start and a goal
    // and nothing else.
    expect(() =>
      drawPathVisualization(ctx, viz({ currentStep: null, finalPath: null }), BASE_CELL_SIZE)
    ).not.toThrow();
    expect(ctx.__callsTo('fill').length).toBe(2);
  });
});

describe('cell highlights', () => {
  it('outlines the hovered and selected cells differently', () => {
    renderScene(
      ctx,
      scene({ hoveredCell: { x: 1, y: 1 }, selectedCell: { x: 4, y: 4 } })
    );

    const outlines = ctx.__callsTo('strokeRect');
    expect(outlines.map((c) => c.state.strokeStyle)).toEqual([THEME.cyan, THEME.amber]);
  });

  it('ignores a highlight that is outside the grid', () => {
    // Both come from pointer position, which can name a cell off the edge
    // of a grid that has since been resized.
    renderScene(ctx, scene({ hoveredCell: { x: 999, y: 999 }, selectedCell: { x: -1, y: -1 } }));
    expect(ctx.__callsTo('strokeRect')).toHaveLength(0);
  });
});

describe('the frame as a whole', () => {
  it('lays the scene down in order: background, cells, overlay, robots', () => {
    // Robots go last because a live fleet is what the operator is
    // watching; the search overlay goes under them because it is context
    // rather than subject.
    const grid = setCell(createGrid(20, 20), 1, 1, CELL_TYPES.SHELF);

    renderScene(
      ctx,
      scene({
        grid,
        obstacles: [{ id: 'o1', type: 'human_worker', cells: [{ x: 2, y: 2 }] }],
        pathVisualization: {
          currentStep: null,
          finalPath: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          start: null,
          goal: null,
        },
        robots: [robot()],
      })
    );

    const background = 0;
    const obstacleClip = ctx.__firstIndexOf('clip');
    const pathLine = ctx.__firstIndexOf('stroke', (c) => c.state.strokeStyle === THEME.success);
    const robotBody = ctx.__firstIndexOf('fill', (c) => c.state.fillStyle === THEME.textSecondary);

    expect(ctx.__calls[background]).toMatchObject({ method: 'setTransform' });
    expect(obstacleClip).toBeLessThan(pathLine);
    expect(pathLine).toBeLessThan(robotBody);
  });

  it('clears the whole canvas before drawing', () => {
    // Without this the previous frame shows through wherever the new one
    // does not paint - which, on a mostly-empty warehouse, is most of it.
    renderScene(ctx, scene({ width: 800, height: 600 }));
    const first = ctx.__callsTo('fillRect')[0];
    expect(first.args).toEqual([0, 0, 800, 600]);
    expect(first.state.fillStyle).toBe(THEME.bgVoid);
  });

  it('applies the device pixel ratio to the transform', () => {
    // A retina display renders into a bitmap twice the CSS size; without
    // this every line is soft.
    renderScene(ctx, scene({ dpr: 2 }));
    expect(ctx.__callsTo('setTransform')[0].args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('translates by the pan offset, and balances save with restore', () => {
    renderScene(ctx, scene({ offsetX: 40, offsetY: 25 }));
    expect(ctx.__callsTo('translate')[0].args).toEqual([40, 25]);
    // An unbalanced save() leaks clip and transform state into the next
    // frame, which shows up as a canvas that slowly drifts.
    expect(ctx.__callsTo('save').length).toBe(ctx.__callsTo('restore').length);
  });

  it('renders an empty warehouse without throwing', () => {
    expect(() => renderScene(ctx, scene())).not.toThrow();
  });

  it('uses only colours from the theme', () => {
    // The canvas cannot read CSS custom properties, so its palette is
    // mirrored in theme.js - and the way that mirror rots is a hex value
    // hard-coded inline.
    let grid = createGrid(20, 20);
    grid = setCell(grid, 1, 1, CELL_TYPES.SHELF);
    grid = setCell(grid, 2, 2, CELL_TYPES.CHARGING);
    grid = setCell(grid, 3, 3, CELL_TYPES.DOCK);
    grid = setCell(grid, 4, 4, CELL_TYPES.OBSTACLE);

    renderScene(
      ctx,
      scene({
        grid,
        robots: [robot({ status: 'moving' }), robot({ id: 'r2', status: 'error', battery: 5 })],
        obstacles: [{ id: 'o1', type: 'construction_zone', cells: [{ x: 5, y: 5 }] }],
        heatmap: new Map([['1:1', 2]]),
        showHeatmap: true,
        hoveredCell: { x: 0, y: 0 },
        selectedCell: { x: 1, y: 0 },
      })
    );

    const allowed = new Set([
      ...Object.values(THEME),
      ...Object.values(CELL_TYPES).map((t) => cellColor(t)),
      '#000000', // the recording context's initial state, never drawn with
    ]);
    for (const color of ctx.__colorsUsed()) {
      expect(allowed.has(color)).toBe(true);
    }
  });
});
