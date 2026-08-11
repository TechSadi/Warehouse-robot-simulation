import { useEffect, useRef, useState } from 'react';
import { GRID_LIMITS } from '../../engine/grid/gridEngine.js';
import { cellLabel } from '../../engine/grid/cellTypes.js';
import { SCHEDULING_STRATEGIES } from '../../state/useSimulationGrid.js';
import './Panels.css';

export default function ControlPanel({
  grid,
  onResize,
  onClear,
  onExport,
  onImport,
  onGenerateLayout,
  canvasRef,
  zoomPercent,
  selectedCell,
  selectedCellType,
  error,
  dismissError,
  syncedWarehouseId,
  syncStatus,
  syncError,
  onSyncToServer,
  schedulingStrategy,
  onChangeSchedulingStrategy,
  isRunning,
  onStartSimulation,
  onStopSimulation,
  onSpawnRobot,
  onGenerateOrders,
  onDispatchNow,
  showHeatmap,
  onToggleHeatmap,
  actionError,
  dismissActionError,
}) {
  const [rowsInput, setRowsInput] = useState(grid.rows);
  const [colsInput, setColsInput] = useState(grid.cols);
  const [density, setDensity] = useState('balanced');
  const fileInputRef = useRef(null);

  useEffect(() => {
    setRowsInput(grid.rows);
    setColsInput(grid.cols);
  }, [grid.rows, grid.cols]);

  function applyResize(e) {
    e.preventDefault();
    onResize(Number(rowsInput), Number(colsInput));
  }

  function handleExportClick() {
    const json = onExport();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'warehouse-layout.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImport(String(reader.result));
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <section className="panel">
      <p className="eyebrow">Simulation Controls</p>

      {error ? (
        <div className="panel__banner panel__banner--error">
          <span>{error}</span>
          <button type="button" className="panel__banner-dismiss" onClick={dismissError}>
            ×
          </button>
        </div>
      ) : null}

      <form className="control-row" onSubmit={applyResize}>
        <label className="control-field">
          <span>Rows</span>
          <input
            type="number"
            min={GRID_LIMITS.MIN}
            max={GRID_LIMITS.MAX}
            value={rowsInput}
            onChange={(e) => setRowsInput(e.target.value)}
          />
        </label>
        <label className="control-field">
          <span>Cols</span>
          <input
            type="number"
            min={GRID_LIMITS.MIN}
            max={GRID_LIMITS.MAX}
            value={colsInput}
            onChange={(e) => setColsInput(e.target.value)}
          />
        </label>
        <button type="submit" className="panel__button">
          Resize
        </button>
      </form>

      <div className="control-row">
        <button type="button" className="panel__button" onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}>
          −
        </button>
        <span className="control-row__readout readout">{Math.round(zoomPercent * 100)}%</span>
        <button type="button" className="panel__button" onClick={() => canvasRef.current?.zoomBy(1.2)}>
          +
        </button>
        <button type="button" className="panel__button" onClick={() => canvasRef.current?.resetView()}>
          Reset View
        </button>
      </div>

      <div className="control-row">
        <button type="button" className="panel__button" onClick={handleExportClick}>
          Export JSON
        </button>
        <button type="button" className="panel__button" onClick={handleImportClick}>
          Import JSON
        </button>
        <button type="button" className="panel__button panel__button--danger" onClick={onClear}>
          Clear Grid
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="panel__file-input"
          onChange={handleFileChange}
        />
      </div>

      <div className="control-row">
        <label className="control-field control-field--wide">
          <span>Layout Density</span>
          <select value={density} onChange={(e) => setDensity(e.target.value)}>
            <option value="sparse">Sparse</option>
            <option value="balanced">Balanced</option>
            <option value="dense">Dense</option>
          </select>
        </label>
        <button type="button" className="panel__button" onClick={() => onGenerateLayout(density)}>
          Generate Layout
        </button>
      </div>

      <div className="panel__inspector">
        <p className="eyebrow">Selected Cell</p>
        {selectedCell ? (
          <p className="readout">
            X:{selectedCell.x} Y:{selectedCell.y} — {cellLabel(selectedCellType)}
          </p>
        ) : (
          <p className="panel__empty-hint">Nothing selected. Switch to the Select tool and click a cell.</p>
        )}
      </div>

      <div className="panel__inspector panel__scheduling">
        <p className="eyebrow">Robot Scheduling</p>
        <div className="control-row">
          <button type="button" className="panel__button" onClick={onSyncToServer} disabled={syncStatus === 'syncing'}>
            {syncStatus === 'syncing' ? 'Syncing…' : syncedWarehouseId ? 'Re-sync Layout' : 'Sync Layout to Server'}
          </button>
        </div>
        {syncError ? <p className="panel__empty-hint panel__empty-hint--error">{syncError}</p> : null}

        {syncedWarehouseId ? (
          <label className="control-field control-field--wide">
            <span>Assignment Strategy</span>
            <select
              value={schedulingStrategy}
              onChange={(e) => onChangeSchedulingStrategy(e.target.value)}
            >
              {SCHEDULING_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="panel__empty-hint">
            Sync the layout to the server to choose how orders get assigned to robots.
          </p>
        )}
      </div>

      {syncedWarehouseId ? (
        <div className="panel__inspector">
          <p className="eyebrow">Live Simulation</p>

          {actionError ? (
            <div className="panel__banner panel__banner--error">
              <span>{actionError}</span>
              <button type="button" className="panel__banner-dismiss" onClick={dismissActionError}>
                ×
              </button>
            </div>
          ) : null}

          <div className="control-row">
            <button type="button" className="panel__button" onClick={onSpawnRobot}>
              Spawn Robot
            </button>
            <button type="button" className="panel__button" onClick={() => onGenerateOrders(5)}>
              Generate Orders
            </button>
          </div>
          <div className="control-row">
            <button type="button" className="panel__button" onClick={onDispatchNow}>
              Dispatch Now
            </button>
            {isRunning ? (
              <button type="button" className="panel__button panel__button--danger" onClick={onStopSimulation}>
                Stop Simulation
              </button>
            ) : (
              <button type="button" className="panel__button" onClick={onStartSimulation}>
                Start Simulation
              </button>
            )}
          </div>
          <label className="panel__checkbox">
            <input type="checkbox" checked={showHeatmap} onChange={(e) => onToggleHeatmap(e.target.checked)} />
            Show traffic heatmap
          </label>
        </div>
      ) : null}
    </section>
  );
}
