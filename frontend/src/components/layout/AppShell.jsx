import { useRef, useState } from 'react';
import TopNav from './TopNav.jsx';
import ShortcutsHelp from './ShortcutsHelp.jsx';
import Sidebar from '../sidebar/Sidebar.jsx';
import SimulationCanvas from '../simulation/SimulationCanvas.jsx';
import ControlPanel from '../panels/ControlPanel.jsx';
import StatisticsPanel from '../panels/StatisticsPanel.jsx';
import OrdersPanel from '../panels/OrdersPanel.jsx';
import ChartPanel from '../panels/ChartPanel.jsx';
import NotificationsFeed from '../panels/NotificationsFeed.jsx';
import AIVisualizationPanel from '../panels/AIVisualizationPanel.jsx';
import LayoutsPanel from '../panels/LayoutsPanel.jsx';
import LogsPanel from '../panels/LogsPanel.jsx';
import { useSimulationGrid, TOOLS } from '../../state/useSimulationGrid.js';
import { useLiveSimulation } from '../../state/useLiveSimulation.js';
import { usePathVisualization } from '../../state/usePathVisualization.js';
import { useKeyboardShortcuts } from '../../state/useKeyboardShortcuts.js';
import { generateWarehouseLayout } from '../../engine/grid/warehouseGenerator.js';
import './AppShell.css';

export default function AppShell({ connectionStatus }) {
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
    stats,
    syncedWarehouseId,
    syncStatus,
    syncError,
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
  } = useSimulationGrid();

  const {
    robots,
    orders,
    obstacles,
    notifications,
    robotCounts,
    orderCounts,
    avgBattery,
    utilizationPercent,
    history,
    heatmap,
    isRunning,
    startSimulation,
    stopSimulation,
    spawnRandomRobot,
    generateOrders,
    dispatchNow,
    actionError,
    dismissActionError,
    dismissNotification,
  } = useLiveSimulation(syncedWarehouseId, grid);

  const {
    pickMode,
    pickStart,
    pickGoal,
    cancelPick,
    handlePickClick,
    start: pathStart,
    goal: pathGoal,
    heuristic: pathHeuristic,
    setHeuristic: setPathHeuristic,
    allowDiagonal: pathAllowDiagonal,
    setAllowDiagonal: setPathAllowDiagonal,
    run: runPathVisualization,
    isRunning: isRunningPathVisualization,
    runError: pathRunError,
    reset: resetPathVisualization,
    result: pathResult,
    currentStep: pathCurrentStep,
    stepIndex: pathStepIndex,
    totalSteps: pathTotalSteps,
    stepForward: pathStepForward,
    stepBackward: pathStepBackward,
    play: playPathVisualization,
    pause: pausePathVisualization,
    isPlaying: isPathVisualizationPlaying,
    speedMs: pathSpeedMs,
    setSpeedMs: setPathSpeedMs,
    minSpeedMs: pathMinSpeedMs,
    maxSpeedMs: pathMaxSpeedMs,
  } = usePathVisualization(syncedWarehouseId);

  const canvasRef = useRef(null);
  const [zoomPercent, setZoomPercent] = useState(1);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const isPaintTool = activeTool !== TOOLS.SELECT;

  // A pick-mode click (setting the AI Visualisation Panel's start/goal
  // cell) takes priority over the normal grid-editing tool - it never
  // paints a cell, it only records a coordinate.
  function handleCanvasCellClick(x, y) {
    if (handlePickClick(x, y)) return;
    handleCellClick(x, y);
  }

  // Milestone 13: procedurally fills the grid at its current dimensions -
  // replaces whatever's there now, same as Clear Grid, just with a
  // generated floor plan instead of an empty one.
  function handleGenerateLayout(density) {
    applyGrid(generateWarehouseLayout({ rows: grid.rows, cols: grid.cols, density }), {
      name: 'Generated Layout',
    });
  }

  useKeyboardShortcuts({
    onSetTool: setActiveTool,
    onEraseSelected: handleCellErase,
    selectedCell,
    onDeselect: deselectCell,
    isRunning,
    onStartSimulation: startSimulation,
    onStopSimulation: stopSimulation,
    canRunSimulation: Boolean(syncedWarehouseId),
    pickMode,
    onCancelPick: cancelPick,
    onToggleHelp: () => setShowShortcutsHelp((v) => !v),
  });

  const pathVisualization =
    pathStart || pathGoal || pathCurrentStep
      ? {
          start: pathStart,
          goal: pathGoal,
          currentStep: pathCurrentStep,
          finalPath: pathResult?.found ? pathResult.path : null,
        }
      : null;

  return (
    <div className="app-shell">
      <TopNav connectionStatus={connectionStatus} onShowShortcuts={() => setShowShortcutsHelp(true)} />
      {showShortcutsHelp ? <ShortcutsHelp onClose={() => setShowShortcutsHelp(false)} /> : null}
      <div className="app-shell__body">
        <Sidebar activeTool={activeTool} setActiveTool={setActiveTool} robots={robots} />

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
          onZoomChange={setZoomPercent}
          robots={robots}
          heatmap={heatmap}
          showHeatmap={showHeatmap}
          obstacles={obstacles}
          pathVisualization={pathVisualization}
          pickMode={pickMode}
        />

        <div className="app-shell__rail">
          <ControlPanel
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
            onSyncToServer={syncToServer}
            schedulingStrategy={schedulingStrategy}
            onChangeSchedulingStrategy={changeSchedulingStrategy}
            isRunning={isRunning}
            onStartSimulation={startSimulation}
            onStopSimulation={stopSimulation}
            onSpawnRobot={spawnRandomRobot}
            onGenerateOrders={generateOrders}
            onDispatchNow={dispatchNow}
            showHeatmap={showHeatmap}
            onToggleHeatmap={setShowHeatmap}
            actionError={actionError}
            dismissActionError={dismissActionError}
          />
          <StatisticsPanel
            grid={grid}
            stats={stats}
            robotCounts={robotCounts}
            orderCounts={orderCounts}
            avgBattery={avgBattery}
            utilizationPercent={utilizationPercent}
          />
          <OrdersPanel orders={orders} />
          <NotificationsFeed notifications={notifications} onDismiss={dismissNotification} />
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
          />
          <AIVisualizationPanel
            syncedWarehouseId={syncedWarehouseId}
            pickMode={pickMode}
            onPickStart={pickStart}
            onPickGoal={pickGoal}
            onCancelPick={cancelPick}
            start={pathStart}
            goal={pathGoal}
            heuristic={pathHeuristic}
            onChangeHeuristic={setPathHeuristic}
            allowDiagonal={pathAllowDiagonal}
            onChangeAllowDiagonal={setPathAllowDiagonal}
            onRun={runPathVisualization}
            isRunning={isRunningPathVisualization}
            runError={pathRunError}
            result={pathResult}
            currentStep={pathCurrentStep}
            stepIndex={pathStepIndex}
            totalSteps={pathTotalSteps}
            onStepForward={pathStepForward}
            onStepBackward={pathStepBackward}
            onPlay={playPathVisualization}
            onPause={pausePathVisualization}
            isPlaying={isPathVisualizationPlaying}
            speedMs={pathSpeedMs}
            onChangeSpeed={setPathSpeedMs}
            minSpeedMs={pathMinSpeedMs}
            maxSpeedMs={pathMaxSpeedMs}
            onReset={resetPathVisualization}
          />
          <LogsPanel syncedWarehouseId={syncedWarehouseId} />
          <ChartPanel history={history} />
        </div>
      </div>
    </div>
  );
}
