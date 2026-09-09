import { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import TopNav from './TopNav.jsx';
import ShortcutsHelp from './ShortcutsHelp.jsx';
import Sidebar from '../sidebar/Sidebar.jsx';
import SimulationCanvas from '../simulation/SimulationCanvas.jsx';
import ErrorBoundary from '../common/ErrorBoundary.jsx';
import WarehouseControls from '../panels/WarehouseControls.jsx';
import SimulationControls from '../panels/SimulationControls.jsx';
import ObstaclesPanel from '../panels/ObstaclesPanel.jsx';
import StatisticsPanel from '../panels/StatisticsPanel.jsx';
import OrdersPanel from '../panels/OrdersPanel.jsx';
import NotificationsFeed from '../panels/NotificationsFeed.jsx';
import AIVisualizationPanel from '../panels/AIVisualizationPanel.jsx';
import LayoutsPanel from '../panels/LayoutsPanel.jsx';
import LogsPanel from '../panels/LogsPanel.jsx';
import { useSimulationGrid, TOOLS } from '../../state/useSimulationGrid.js';
import { useLiveSimulation } from '../../state/useLiveSimulation.js';
import { usePathVisualization } from '../../state/usePathVisualization.js';
import { useKeyboardShortcuts } from '../../state/useKeyboardShortcuts.js';
import { generateWarehouseLayout } from '../../engine/grid/warehouseGenerator.js';
import { LoadingState } from '../common/Feedback.jsx';
import { ACTIVE_ORDER_STATUSES } from '../../utils/format.js';
import './AppShell.css';

/**
 * The activity chart pulls in recharts, which measured at 501 kB of a 632 kB
 * production bundle - 80% of the JavaScript the browser had to parse before
 * anything could paint, for one panel at the bottom of a scrolling rail that
 * shows an empty state until a simulation is actually running. Loading it on
 * demand is the single largest measurable win available here; everything else
 * in this file is small enough that deferring it would be ceremony.
 */
const ChartPanel = lazy(() => import('../panels/ChartPanel.jsx'));

/**
 * Composes the dashboard from three independent state hooks:
 *
 *  - `useSimulationGrid` - the layout being drawn, and its saved records.
 *  - `useLiveSimulation` - the live fleet for whichever warehouse is
 *    currently synced. Keyed off `syncedWarehouseId`, so switching layouts
 *    tears down one warehouse's subscription and sets up the next.
 *  - `usePathVisualization` - the A* trace scrubber, also keyed off the
 *    synced warehouse.
 *
 * Every panel below is wrapped in its own error boundary. They render
 * server data whose shape this client does not control, and one panel
 * throwing should cost the user that panel, not the whole dashboard and
 * with it the sign-out button.
 */
export default function AppShell({ apiHealth, onRecheckApi, realtimeState }) {
  const {
    grid,
    activeTool,
    setActiveTool,
    selectedCell,
    selectedCellType,
    hoveredCell,
    setHoveredCell,
    error,
    dismissError,
    resize,
    resetGrid,
    deselectCell,
    exportJSON,
    importJSON,
    applyGrid,
    handleCellClick,
    handleCellPaint,
    handleCellErase,
    moveSelection,
    stats,
    syncedWarehouseId,
    syncStatus,
    syncError,
    dismissSyncError,
    syncToServer,
    schedulingStrategy,
    changeSchedulingStrategy,
    layoutName,
    setLayoutName,
    saveLayoutAs,
    loadLayout,
    savedLayouts,
    layoutsStatus,
    layoutsError,
    refreshSavedLayouts,
    deleteLayout,
    deletingLayoutId,
  } = useSimulationGrid();

  const simulation = useLiveSimulation(syncedWarehouseId, grid);
  const path = usePathVisualization(syncedWarehouseId);

  const canvasRef = useRef(null);
  const [zoomPercent, setZoomPercent] = useState(1);
  const [showHeatmap, setShowHeatmap] = useState(false);
  // Whether the *next* start should keep the simulation running after the
  // last watcher leaves. Client state, not server state: it describes an
  // intention about a command not yet sent, and the server's
  // `simulation:status` reports what a running loop actually is.
  const [runInBackground, setRunInBackground] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const isPaintTool = activeTool !== TOOLS.SELECT;

  // A pick-mode click (setting the path panel's start/goal cell) takes
  // priority over the normal grid-editing tool - it never paints a cell, it
  // only records a coordinate.
  const handleCanvasCellClick = useCallback(
    (x, y) => {
      if (path.handlePickClick(x, y)) return;
      handleCellClick(x, y);
    },
    [path, handleCellClick]
  );

  // Procedurally fills the grid at its current dimensions - replaces
  // whatever is there now, same as Clear Grid, just with a generated floor
  // plan instead of an empty one.
  //
  // It used to pass `name: 'Generated Layout'` unconditionally, which
  // silently overwrote a name the user had already typed: name your layout
  // "Night shift", click Generate, and it saved as "Generated Layout"
  // instead, with nothing on screen explaining where the name went. A
  // default is only a default when there is nothing to default over.
  const handleGenerateLayout = useCallback(
    (density) => {
      applyGrid(generateWarehouseLayout({ rows: grid.rows, cols: grid.cols, density }), {
        name: layoutName.trim() ? undefined : 'Generated Layout',
      });
    },
    [applyGrid, grid.rows, grid.cols, layoutName]
  );

  const toggleShortcutsHelp = useCallback(() => setShowShortcutsHelp((value) => !value), []);
  const openShortcutsHelp = useCallback(() => setShowShortcutsHelp(true), []);
  const closeShortcutsHelp = useCallback(() => setShowShortcutsHelp(false), []);

  useKeyboardShortcuts({
    onSetTool: setActiveTool,
    onEraseSelected: handleCellErase,
    selectedCell,
    onDeselect: deselectCell,
    isRunning: simulation.isRunning,
    onStartSimulation: simulation.startSimulation,
    onStopSimulation: simulation.stopSimulation,
    canRunSimulation: Boolean(syncedWarehouseId) && simulation.canControl,
    pickMode: path.pickMode,
    onCancelPick: path.cancelPick,
    onToggleHelp: toggleShortcutsHelp,
  });

  const pathVisualization = useMemo(() => {
    if (!path.start && !path.goal && !path.currentStep) return null;
    return {
      start: path.start,
      goal: path.goal,
      currentStep: path.currentStep,
      finalPath: path.result?.found ? path.result.path : null,
    };
  }, [path.start, path.goal, path.currentStep, path.result]);

  const activeOrderCount = useMemo(
    () => simulation.orders.filter((order) => ACTIVE_ORDER_STATUSES.includes(order.status)).length,
    [simulation.orders]
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#simulation-grid">
        Skip to the simulation grid
      </a>

      <TopNav
        apiHealth={apiHealth}
        onRecheckApi={onRecheckApi}
        realtimeState={realtimeState}
        onShowShortcuts={openShortcutsHelp}
      />

      {showShortcutsHelp ? <ShortcutsHelp onClose={closeShortcutsHelp} /> : null}

      <div className="app-shell__body">
        <ErrorBoundary label="The fleet roster">
          <Sidebar
            activeTool={activeTool}
            setActiveTool={setActiveTool}
            robots={simulation.robots}
            isLoading={simulation.isLoading}
            hasWarehouse={Boolean(syncedWarehouseId)}
          />
        </ErrorBoundary>

        <ErrorBoundary label="The simulation grid">
          <SimulationCanvas
            canvasRef={canvasRef}
            grid={grid}
            selectedCell={selectedCell}
            selectedCellType={selectedCellType}
            hoveredCell={hoveredCell}
            setHoveredCell={setHoveredCell}
            isPaintTool={isPaintTool}
            onCellClick={handleCanvasCellClick}
            onCellPaint={handleCellPaint}
            onCellErase={handleCellErase}
            onMoveSelection={moveSelection}
            onZoomChange={setZoomPercent}
            robots={simulation.robots}
            heatmap={simulation.heatmap}
            heatmapEpoch={simulation.heatmapEpoch}
            showHeatmap={showHeatmap}
            obstacles={simulation.obstacles}
            pathVisualization={pathVisualization}
            pickMode={path.pickMode}
            isRunning={simulation.isRunning}
            isStale={simulation.isStale}
          />
        </ErrorBoundary>

        <div className="app-shell__rail">
          <ErrorBoundary label="Simulation controls">
            <SimulationControls
              syncedWarehouseId={syncedWarehouseId}
              isRunning={simulation.isRunning}
              isLoading={simulation.isLoading}
              isStale={simulation.isStale}
              canControl={simulation.canControl}
              connection={simulation.connection}
              syncedAt={simulation.syncedAt}
              robotCount={simulation.robots.length}
              activeOrderCount={activeOrderCount}
              lowBatteryCount={simulation.lowBatteryCount}
              avgBattery={simulation.avgBattery}
              errorRobotCount={simulation.robotCounts.error}
              pendingAction={simulation.pendingAction}
              onStartSimulation={simulation.startSimulation}
              onStopSimulation={simulation.stopSimulation}
              runInBackground={runInBackground}
              onToggleRunInBackground={setRunInBackground}
              onSpawnRobot={simulation.spawnRandomRobot}
              onGenerateOrders={simulation.generateOrders}
              onDispatchNow={simulation.dispatchNow}
              showHeatmap={showHeatmap}
              onToggleHeatmap={setShowHeatmap}
              onClearHeatmap={simulation.clearHeatmap}
              actionError={simulation.actionError}
              dismissActionError={simulation.dismissActionError}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Warehouse controls">
            <WarehouseControls
              grid={grid}
              onResize={resize}
              onClear={resetGrid}
              onExport={exportJSON}
              onImport={importJSON}
              onGenerateLayout={handleGenerateLayout}
              canvasRef={canvasRef}
              zoomPercent={zoomPercent}
              selectedCell={selectedCell}
              selectedCellType={selectedCellType}
              error={error}
              dismissError={dismissError}
              syncedWarehouseId={syncedWarehouseId}
              syncStatus={syncStatus}
              syncError={syncError}
              dismissSyncError={dismissSyncError}
              onSyncToServer={syncToServer}
              schedulingStrategy={schedulingStrategy}
              onChangeSchedulingStrategy={changeSchedulingStrategy}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Statistics">
            <StatisticsPanel
              grid={grid}
              stats={stats}
              robotCounts={simulation.robotCounts}
              orderCounts={simulation.orderCounts}
              avgBattery={simulation.avgBattery}
              utilizationPercent={simulation.utilizationPercent}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Orders">
            <OrdersPanel
              orders={simulation.orders}
              isLoading={simulation.isLoading}
              deliveredCount={simulation.orderCounts.delivered}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Dynamic obstacles">
            <ObstaclesPanel
              syncedWarehouseId={syncedWarehouseId}
              obstacles={simulation.obstacles}
              selectedCell={selectedCell}
              pendingAction={simulation.pendingAction}
              onAddObstacle={simulation.addObstacle}
              onRemoveObstacle={simulation.removeObstacle}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Live activity">
            <NotificationsFeed
              notifications={simulation.notifications}
              onDismiss={simulation.dismissNotification}
              onClearAll={simulation.clearNotifications}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Saved layouts">
            <LayoutsPanel
              layoutName={layoutName}
              onChangeLayoutName={setLayoutName}
              syncedWarehouseId={syncedWarehouseId}
              syncStatus={syncStatus}
              onSaveLayoutAs={saveLayoutAs}
              savedLayouts={savedLayouts}
              layoutsStatus={layoutsStatus}
              layoutsError={layoutsError}
              onRefreshLayouts={refreshSavedLayouts}
              onLoadLayout={loadLayout}
              onDeleteLayout={deleteLayout}
              deletingLayoutId={deletingLayoutId}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Path visualisation">
            <AIVisualizationPanel
              syncedWarehouseId={syncedWarehouseId}
              pickMode={path.pickMode}
              onPickStart={path.pickStart}
              onPickGoal={path.pickGoal}
              onCancelPick={path.cancelPick}
              start={path.start}
              goal={path.goal}
              onClearStart={path.clearStart}
              onClearGoal={path.clearGoal}
              heuristic={path.heuristic}
              onChangeHeuristic={path.setHeuristic}
              allowDiagonal={path.allowDiagonal}
              onChangeAllowDiagonal={path.setAllowDiagonal}
              onRun={path.run}
              isRunning={path.isRunning}
              runError={path.runError}
              onDismissRunError={path.dismissRunError}
              result={path.result}
              currentStep={path.currentStep}
              stepIndex={path.stepIndex}
              totalSteps={path.totalSteps}
              onStepForward={path.stepForward}
              onStepBackward={path.stepBackward}
              onPlay={path.play}
              onPause={path.pause}
              isPlaying={path.isPlaying}
              speedMs={path.speedMs}
              onChangeSpeed={path.setSpeedMs}
              minSpeedMs={path.minSpeedMs}
              maxSpeedMs={path.maxSpeedMs}
              onReset={path.reset}
            />
          </ErrorBoundary>

          <ErrorBoundary label="Logs">
            <LogsPanel syncedWarehouseId={syncedWarehouseId} />
          </ErrorBoundary>

          <ErrorBoundary label="The activity chart">
            <Suspense fallback={<LoadingState label="Loading the activity chart…" />}>
              <ChartPanel history={simulation.history} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
