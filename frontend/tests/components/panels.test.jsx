import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Sidebar from '../../src/components/sidebar/Sidebar.jsx';
import OrdersPanel from '../../src/components/panels/OrdersPanel.jsx';
import ObstaclesPanel from '../../src/components/panels/ObstaclesPanel.jsx';
import StatisticsPanel from '../../src/components/panels/StatisticsPanel.jsx';
import NotificationsFeed from '../../src/components/panels/NotificationsFeed.jsx';
import ChartPanel from '../../src/components/panels/ChartPanel.jsx';
import AIVisualizationPanel from '../../src/components/panels/AIVisualizationPanel.jsx';
import ErrorBoundary from '../../src/components/common/ErrorBoundary.jsx';
import { createGrid } from '../../src/engine/grid/gridEngine.js';
import { TOOLS } from '../../src/state/useSimulationGrid.js';

const robot = (id, overrides = {}) => ({
  id,
  name: `Robot ${id}`,
  status: 'idle',
  battery: 100,
  position: { x: 1, y: 2 },
  rotation: 0,
  ...overrides,
});

const order = (id, overrides = {}) => ({
  _id: id,
  status: 'pending',
  priority: 'normal',
  pickupLocation: { x: 1, y: 1 },
  deliveryLocation: { x: 5, y: 5 },
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  ...overrides,
});

// --- Robot visualisation (fleet roster) --------------------------------------

describe('Sidebar fleet roster', () => {
  const props = { activeTool: TOOLS.SELECT, setActiveTool: vi.fn() };

  it('shows an empty state that says how to get robots', () => {
    render(<Sidebar {...props} robots={[]} hasWarehouse />);

    expect(screen.getByText(/no robots yet/i)).toBeInTheDocument();
    expect(screen.getByText(/spawn robot/i)).toBeInTheDocument();
  });

  it('tells the user to sync first when there is no warehouse at all', () => {
    render(<Sidebar {...props} robots={[]} hasWarehouse={false} />);

    expect(screen.getByText(/sync the layout to the server first/i)).toBeInTheDocument();
  });

  it('shows a loading state instead of a misleading "no robots"', () => {
    render(<Sidebar {...props} robots={[]} isLoading />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading fleet/i);
    expect(screen.queryByText(/no robots yet/i)).not.toBeInTheDocument();
  });

  it('renders each robot with status, position and battery as text, not only colour', () => {
    render(
      <Sidebar
        {...props}
        robots={[robot('r1', { status: 'moving', battery: 62.4, position: { x: 3, y: 8 } })]}
      />
    );

    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Robot r1')).toBeInTheDocument();
    expect(within(row).getByText('Moving')).toBeInTheDocument();
    expect(within(row).getByText(/X:3 Y:8 · 62%/)).toBeInTheDocument();
  });

  it('exposes battery as a progressbar with a value', () => {
    render(<Sidebar {...props} robots={[robot('r1', { battery: 45 })]} />);

    const bar = screen.getByRole('progressbar', { name: /Robot r1 battery/i });
    expect(bar).toHaveAttribute('aria-valuenow', '45');
  });

  it('marks a waiting robot', () => {
    render(<Sidebar {...props} robots={[robot('r1', { isWaiting: true })]} />);

    expect(screen.getByText(/waiting/)).toBeInTheDocument();
  });

  it('counts the fleet in the heading', () => {
    render(<Sidebar {...props} robots={[robot('r1'), robot('r2')]} />);

    expect(screen.getByRole('heading', { name: /fleet roster \(2\)/i })).toBeInTheDocument();
  });

  it('exposes the tool palette as a radio group', async () => {
    const user = userEvent.setup();
    const setActiveTool = vi.fn();
    render(<Sidebar activeTool={TOOLS.SELECT} setActiveTool={setActiveTool} robots={[]} />);

    const select = screen.getByRole('radio', { name: /select/i });
    expect(select).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: /shelf/i }));
    expect(setActiveTool).toHaveBeenCalledWith('shelf');
  });
});

// --- Orders -------------------------------------------------------------------

describe('OrdersPanel', () => {
  it('explains how to create orders when there are none', () => {
    render(<OrdersPanel orders={[]} />);

    expect(screen.getByText('No orders yet.')).toBeInTheDocument();
    expect(screen.getByText(/generate orders.*dispatch now/i)).toBeInTheDocument();
  });

  it('distinguishes "none yet" from "all delivered"', () => {
    render(<OrdersPanel orders={[order('o1', { status: 'delivered' })]} deliveredCount={4} />);

    expect(screen.getByText(/4 orders delivered/i)).toBeInTheDocument();
  });

  it('shows a loading state rather than an empty one during the first load', () => {
    render(<OrdersPanel orders={[]} isLoading />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading orders/i);
  });

  it('lists only active orders', () => {
    render(
      <OrdersPanel
        orders={[
          order('o1', { status: 'pending' }),
          order('o2', { status: 'delivered' }),
          order('o3', { status: 'cancelled' }),
          order('o4', { status: 'picked_up' }),
        ]}
      />
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: /active orders \(2\)/i })).toBeInTheDocument();
  });

  it('puts urgent work at the top rather than merely the newest', () => {
    render(
      <OrdersPanel
        orders={[
          order('o1', { priority: 'low', createdAt: '2026-01-02T00:00:00Z' }),
          order('o2', { priority: 'urgent', createdAt: '2026-01-01T00:00:00Z' }),
        ]}
      />
    );

    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('Urgent')).toBeInTheDocument();
  });

  it('caps the list and says how many are hidden', () => {
    const orders = Array.from({ length: 12 }, (_, i) => order(`o${i}`));
    render(<OrdersPanel orders={orders} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText(/4 more orders not shown/i)).toBeInTheDocument();
  });

  it('renders human-readable status labels', () => {
    render(<OrdersPanel orders={[order('o1', { status: 'picked_up' })]} />);

    expect(screen.getByText('Picked up')).toBeInTheDocument();
  });
});

// --- Obstacles ----------------------------------------------------------------

describe('ObstaclesPanel', () => {
  const base = {
    syncedWarehouseId: 'w1',
    obstacles: [],
    selectedCell: null,
    pendingAction: null,
    onAddObstacle: vi.fn(),
    onRemoveObstacle: vi.fn(),
  };

  it('asks for a warehouse before offering obstacle controls', () => {
    render(<ObstaclesPanel {...base} syncedWarehouseId={null} />);

    expect(screen.getByText(/nowhere to place obstacles/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /place here/i })).not.toBeInTheDocument();
  });

  it('shows an empty state describing what obstacles are for', () => {
    render(<ObstaclesPanel {...base} />);

    expect(screen.getByText(/no obstacles on the floor/i)).toBeInTheDocument();
    expect(screen.getByText(/re-plan around it/i)).toBeInTheDocument();
  });

  it('cannot place without a target cell, and says why', () => {
    render(<ObstaclesPanel {...base} selectedCell={null} />);

    const button = screen.getByRole('button', { name: /place here/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/select a cell on the grid/i)).toBeInTheDocument();
  });

  it('places the chosen obstacle type at the selected cell', async () => {
    const user = userEvent.setup();
    const onAddObstacle = vi.fn();
    render(<ObstaclesPanel {...base} selectedCell={{ x: 4, y: 6 }} onAddObstacle={onAddObstacle} />);

    await user.selectOptions(screen.getByLabelText(/obstacle type/i), 'construction_zone');
    await user.click(screen.getByRole('button', { name: /place here/i }));

    expect(onAddObstacle).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'construction_zone', cells: [{ x: 4, y: 6 }] })
    );
    // The server rejects duplicate ids, so each placement needs its own.
    expect(onAddObstacle.mock.calls[0][0].id).toMatch(/^ui-4-6-/);
  });

  it('lists obstacles with type, footprint and lifetime', () => {
    render(
      <ObstaclesPanel
        {...base}
        obstacles={[
          { id: 'o1', type: 'human_worker', cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }], remainingSeconds: 30 },
          { id: 'o2', type: 'broken_robot', cells: [{ x: 9, y: 9 }], remainingSeconds: null },
        ]}
      />
    );

    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('Human worker')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/2 cells · X:2 Y:2 · 30s left/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/1 cell · X:9 Y:9 · permanent/)).toBeInTheDocument();
  });

  it('removes an obstacle', async () => {
    const user = userEvent.setup();
    const onRemoveObstacle = vi.fn();
    render(
      <ObstaclesPanel
        {...base}
        obstacles={[{ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: null }]}
        onRemoveObstacle={onRemoveObstacle}
      />
    );

    await user.click(screen.getByRole('button', { name: /remove/i }));

    expect(onRemoveObstacle).toHaveBeenCalledWith('o1');
  });

  it('blocks further changes while one is in flight', () => {
    render(<ObstaclesPanel {...base} selectedCell={{ x: 1, y: 1 }} pendingAction="obstacle" />);

    expect(screen.getByRole('button', { name: /placing/i })).toBeDisabled();
  });
});

// --- Statistics ---------------------------------------------------------------

describe('StatisticsPanel', () => {
  const base = {
    grid: createGrid(10, 20),
    stats: { shelf: 4, obstacle: 2 },
    robotCounts: { idle: 0, moving: 0, charging: 0, error: 0 },
    orderCounts: { pending: 0, assigned: 0, picked_up: 0, delivered: 0, cancelled: 0 },
    avgBattery: 0,
    utilizationPercent: 0,
  };

  it('shows placeholders instead of zeroes for a fleet that does not exist', () => {
    render(<StatisticsPanel {...base} />);

    expect(screen.getByText(/spawn a robot to see fleet activity/i)).toBeInTheDocument();
    // Four fleet tiles read "—" rather than claiming 0% battery on no robots.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('reports fleet numbers once robots exist', () => {
    render(
      <StatisticsPanel
        {...base}
        robotCounts={{ idle: 1, moving: 2, charging: 1, error: 0 }}
        orderCounts={{ pending: 3, assigned: 1, picked_up: 0, delivered: 7, cancelled: 0 }}
        avgBattery={71.6}
        utilizationPercent={75}
      />
    );

    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText(/4 active orders in the queue/i)).toBeInTheDocument();
  });

  it('reports grid dimensions as columns by rows', () => {
    render(<StatisticsPanel {...base} />);

    expect(screen.getByText('20×10')).toBeInTheDocument();
  });
});

// --- Notifications ------------------------------------------------------------

describe('NotificationsFeed', () => {
  it('explains what will appear when the feed is empty', () => {
    render(<NotificationsFeed notifications={[]} />);

    expect(screen.getByText(/nothing has happened yet/i)).toBeInTheDocument();
  });

  it('announces new events politely rather than interrupting', () => {
    render(
      <NotificationsFeed
        notifications={[{ id: 'n1', message: 'Robot 2 failed', level: 'error', timestamp: Date.now() }]}
      />
    );

    const list = screen.getByRole('list');
    expect(list).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText(/robot 2 failed/i)).toBeInTheDocument();
  });

  it('names the severity for screen readers, since the dot is colour only', () => {
    render(<NotificationsFeed notifications={[{ id: 'n1', message: 'Delivered', level: 'warn' }]} />);

    expect(screen.getByText('Warning:')).toBeInTheDocument();
  });

  it('dismisses one notification by name', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <NotificationsFeed
        notifications={[{ id: 'n1', message: 'Robot 2 failed', level: 'error' }]}
        onDismiss={onDismiss}
      />
    );

    await user.click(screen.getByRole('button', { name: /dismiss: robot 2 failed/i }));

    expect(onDismiss).toHaveBeenCalledWith('n1');
  });

  it('clears the whole feed', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    render(
      <NotificationsFeed notifications={[{ id: 'n1', message: 'x' }]} onClearAll={onClearAll} />
    );

    await user.click(screen.getByRole('button', { name: /clear all/i }));

    expect(onClearAll).toHaveBeenCalled();
  });
});

// --- Chart --------------------------------------------------------------------

describe('ChartPanel', () => {
  it('explains that the chart fills once the simulation runs', () => {
    render(<ChartPanel history={[]} />);

    expect(screen.getByText(/no activity recorded/i)).toBeInTheDocument();
  });

  it('needs more than one point before it draws a line', () => {
    render(<ChartPanel history={[{ t: 0, active: 1, delivered: 0 }]} />);

    expect(screen.getByText(/no activity recorded/i)).toBeInTheDocument();
  });

  it('summarises the latest sample in text, since an SVG chart is unreadable to a screen reader', () => {
    render(
      <ChartPanel
        history={[
          { t: 0, active: 1, delivered: 0 },
          { t: 1, active: 3, delivered: 2 },
        ]}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Over the last 1 seconds: 3 active robots, 2 delivered orders.'
    );
  });
});

// --- Path visualisation -------------------------------------------------------

describe('AIVisualizationPanel', () => {
  const base = {
    syncedWarehouseId: 'w1',
    pickMode: null,
    onPickStart: vi.fn(),
    onPickGoal: vi.fn(),
    onCancelPick: vi.fn(),
    start: null,
    goal: null,
    onClearStart: vi.fn(),
    onClearGoal: vi.fn(),
    heuristic: 'manhattan',
    onChangeHeuristic: vi.fn(),
    allowDiagonal: false,
    onChangeAllowDiagonal: vi.fn(),
    onRun: vi.fn(),
    isRunning: false,
    runError: null,
    onDismissRunError: vi.fn(),
    result: null,
    currentStep: null,
    stepIndex: -1,
    totalSteps: 0,
    onStepForward: vi.fn(),
    onStepBackward: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    isPlaying: false,
    speedMs: 300,
    onChangeSpeed: vi.fn(),
    minSpeedMs: 50,
    maxSpeedMs: 1000,
    onReset: vi.fn(),
  };

  it('asks for a synced warehouse first', () => {
    render(<AIVisualizationPanel {...base} syncedWarehouseId={null} />);

    expect(screen.getByText(/no warehouse synced/i)).toBeInTheDocument();
  });

  it('cannot search without both endpoints, and says which are missing', () => {
    render(<AIVisualizationPanel {...base} />);

    const run = screen.getByRole('button', { name: /find path/i });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringMatching(/start and a goal/i));
    expect(screen.getAllByText('Not set')).toHaveLength(2);
  });

  it('shows an empty state before any search has run', () => {
    render(<AIVisualizationPanel {...base} start={{ x: 0, y: 0 }} goal={{ x: 2, y: 2 }} />);

    expect(screen.getByText(/no search run yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find path/i })).toBeEnabled();
  });

  it('explains a search that found no route at all', () => {
    render(
      <AIVisualizationPanel
        {...base}
        start={{ x: 0, y: 0 }}
        goal={{ x: 2, y: 2 }}
        totalSteps={0}
        result={{ found: false, cost: 0, nodesExplored: 0, executionTimeMs: 0.4 }}
      />
    );

    expect(screen.getByText(/no route between those cells/i)).toBeInTheDocument();
    expect(screen.getByText(/shelf, an obstacle, or walled off/i)).toBeInTheDocument();
  });

  it('marks the active pick button as pressed and explains the interaction', () => {
    render(<AIVisualizationPanel {...base} pickMode="start" />);

    expect(screen.getByRole('button', { name: /click a cell/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/press escape to cancel/i)).toBeInTheDocument();
  });

  it('exposes the scrubber once a trace exists', async () => {
    const user = userEvent.setup();
    const onStepForward = vi.fn();
    render(
      <AIVisualizationPanel
        {...base}
        start={{ x: 0, y: 0 }}
        goal={{ x: 2, y: 0 }}
        totalSteps={3}
        stepIndex={0}
        currentStep={{ current: { x: 0, y: 0, g: 0, h: 2, f: 2 }, openSet: [], closedSet: [] }}
        result={{ found: true, cost: 2, nodesExplored: 3, executionTimeMs: 0.5 }}
        onStepForward={onStepForward}
      />
    );

    expect(screen.getByRole('heading', { name: /step 1 \/ 3/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /forward/i }));
    expect(onStepForward).toHaveBeenCalled();
  });

  it('clears a chosen endpoint', async () => {
    const user = userEvent.setup();
    const onClearStart = vi.fn();
    render(<AIVisualizationPanel {...base} start={{ x: 1, y: 1 }} onClearStart={onClearStart} />);

    await user.click(screen.getByRole('button', { name: /clear start cell/i }));

    expect(onClearStart).toHaveBeenCalled();
  });

  it('shows a dismissible error when the search request fails', async () => {
    const user = userEvent.setup();
    const onDismissRunError = vi.fn();
    render(
      <AIVisualizationPanel {...base} runError="Too many requests." onDismissRunError={onDismissRunError} />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests.');
    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(onDismissRunError).toHaveBeenCalled();
  });
});

// --- Error boundary -----------------------------------------------------------

describe('ErrorBoundary', () => {
  function Boom() {
    throw new Error('render exploded');
  }

  it('contains a panel failure and offers a way back', async () => {
    // React re-throws a caught render error so devtools can see it; jsdom
    // then reports it as an uncaught error. Both are expected here and only
    // noise, so they are suppressed for the duration of this test.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const swallow = (event) => event.preventDefault();
    window.addEventListener('error', swallow);
    const user = userEvent.setup();

    render(
      <ErrorBoundary label="Orders">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Orders stopped working.');
    expect(screen.getByText(/rest of the dashboard is still running/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    window.removeEventListener('error', swallow);
    consoleError.mockRestore();
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <ErrorBoundary label="Orders">
        <p>All good</p>
      </ErrorBoundary>
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
