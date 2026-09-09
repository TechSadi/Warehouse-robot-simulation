import { memo, useEffect, useId, useRef, useState } from 'react';
import { GRID_LIMITS } from '../../engine/grid/gridEngine.js';
import { cellLabel } from '../../engine/grid/cellTypes.js';
import { SCHEDULING_STRATEGIES, SYNC_STATUS } from '../../state/useSimulationGrid.js';
import { Banner, StatusMessage } from '../common/Feedback.jsx';
import { formatCoords } from '../../utils/format.js';
import './Panels.css';

/**
 * Everything that shapes the warehouse itself: its dimensions, its
 * contents, the view onto it, and its relationship to the server.
 *
 * This and SimulationControls used to be one 245-line ControlPanel taking
 * 29 props, which mixed "edit a drawing" with "drive a live fleet" - two
 * jobs a person does at different times, with different consequences for
 * getting them wrong. Splitting them also makes the sync boundary visible:
 * everything above the Sync button is local, everything below it needs the
 * layout to exist on the server first.
 */
function WarehouseControls({
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
  dismissSyncError,
  onSyncToServer,
  schedulingStrategy,
  onChangeSchedulingStrategy,
}) {
  const [rowsInput, setRowsInput] = useState(grid.rows);
  const [colsInput, setColsInput] = useState(grid.cols);
  const [density, setDensity] = useState('balanced');
  const fileInputRef = useRef(null);
  const rowsId = useId();
  const colsId = useId();
  const densityId = useId();
  const strategyId = useId();

  useEffect(() => {
    setRowsInput(grid.rows);
    setColsInput(grid.cols);
  }, [grid.rows, grid.cols]);

  const isSyncing = syncStatus === SYNC_STATUS.SYNCING;
  const justSaved = syncStatus === SYNC_STATUS.SAVED;

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

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImport(String(reader.result));
    reader.onerror = () => onImport('');
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <section className="panel" aria-labelledby={`${rowsId}-heading`}>
      <h2 className="eyebrow panel__heading" id={`${rowsId}-heading`}>
        Warehouse Layout
      </h2>

      {error ? (
        <Banner tone="error" onDismiss={dismissError}>
          {error}
        </Banner>
      ) : null}

      <form className="control-row" onSubmit={applyResize}>
        <div className="control-field">
          <label htmlFor={rowsId}>Rows</label>
          <input
            id={rowsId}
            type="number"
            min={GRID_LIMITS.MIN}
            max={GRID_LIMITS.MAX}
            value={rowsInput}
            onChange={(e) => setRowsInput(e.target.value)}
          />
        </div>
        <div className="control-field">
          <label htmlFor={colsId}>Cols</label>
          <input
            id={colsId}
            type="number"
            min={GRID_LIMITS.MIN}
            max={GRID_LIMITS.MAX}
            value={colsInput}
            onChange={(e) => setColsInput(e.target.value)}
          />
        </div>
        <button type="submit" className="panel__button">
          Resize
        </button>
      </form>

      <div className="control-row" role="group" aria-label="Zoom and view">
        <button
          type="button"
          className="panel__button"
          onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}
          aria-label="Zoom out"
        >
          <span aria-hidden="true">−</span>
        </button>
        <span className="control-row__readout readout" aria-live="polite">
          {Math.round(zoomPercent * 100)}%
        </span>
        <button
          type="button"
          className="panel__button"
          onClick={() => canvasRef.current?.zoomBy(1.2)}
          aria-label="Zoom in"
        >
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" className="panel__button" onClick={() => canvasRef.current?.resetView()}>
          Reset View
        </button>
      </div>

      <div className="control-row">
        <button type="button" className="panel__button" onClick={handleExportClick}>
          Export JSON
        </button>
        <button type="button" className="panel__button" onClick={() => fileInputRef.current?.click()}>
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
          aria-label="Import a layout JSON file"
        />
      </div>

      <div className="control-row">
        <div className="control-field control-field--wide">
          <label htmlFor={densityId}>Layout Density</label>
          <select id={densityId} value={density} onChange={(e) => setDensity(e.target.value)}>
            <option value="sparse">Sparse</option>
            <option value="balanced">Balanced</option>
            <option value="dense">Dense</option>
          </select>
        </div>
        <button type="button" className="panel__button" onClick={() => onGenerateLayout(density)}>
          Generate Layout
        </button>
      </div>

      <div className="panel__inspector">
        <h3 className="eyebrow panel__heading">Selected Cell</h3>
        {selectedCell ? (
          <p className="readout">
            {formatCoords(selectedCell)} — {cellLabel(selectedCellType)}
          </p>
        ) : (
          <StatusMessage>Nothing selected. Switch to the Select tool and click a cell.</StatusMessage>
        )}
      </div>

      <div className="panel__inspector">
        <h3 className="eyebrow panel__heading">Server Sync</h3>
        <div className="control-row">
          <button type="button" className="panel__button" onClick={onSyncToServer} disabled={isSyncing}>
            {isSyncing ? 'Syncing…' : syncedWarehouseId ? 'Re-sync Layout' : 'Sync Layout to Server'}
          </button>
          {justSaved ? (
            <StatusMessage tone="success">
              <span aria-hidden="true">✓ </span>Saved
            </StatusMessage>
          ) : null}
        </div>

        {syncError ? (
          <Banner tone="error" onDismiss={dismissSyncError}>
            {syncError}
          </Banner>
        ) : null}

        {syncedWarehouseId ? (
          <div className="control-field control-field--wide">
            <label htmlFor={strategyId}>Assignment Strategy</label>
            <select
              id={strategyId}
              value={schedulingStrategy}
              onChange={(e) => onChangeSchedulingStrategy(e.target.value)}
            >
              {SCHEDULING_STRATEGIES.map((strategy) => (
                <option key={strategy.value} value={strategy.value}>
                  {strategy.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <StatusMessage>
            Sync the layout to the server to spawn robots, generate orders, and choose how work is assigned.
          </StatusMessage>
        )}
      </div>
    </section>
  );
}

// Nothing here changes on a simulation tick, so re-rendering it twice a
// second with the rest of the dashboard was pure waste. Every callback it
// takes is stable (useCallback in useSimulationGrid), which is what makes
// this memo actually hold.
export default memo(WarehouseControls);
