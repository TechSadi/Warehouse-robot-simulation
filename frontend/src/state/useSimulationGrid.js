import { useState, useCallback, useMemo } from 'react';
import {
  createGrid,
  setCell,
  getCell,
  resizeGrid,
  clearGrid,
  serializeGrid,
  deserializeGrid,
  countCellsByType,
  isInBounds,
  DEFAULT_ROWS,
  DEFAULT_COLS,
} from '../engine/grid/gridEngine.js';
import { CELL_TYPES } from '../engine/grid/cellTypes.js';
import { createWarehouse, updateWarehouse, listWarehouses, getWarehouse, deleteWarehouse } from '../api/client.js';

export const TOOLS = {
  SELECT: 'select',
  ERASER: 'eraser',
  ...CELL_TYPES,
};

// Keep these labels/keys in sync with backend/src/engine/scheduling/strategies.js.
export const SCHEDULING_STRATEGIES = [
  { value: 'fcfs', label: 'First Come First Serve' },
  { value: 'nearest_robot', label: 'Nearest Robot' },
  { value: 'least_busy', label: 'Least Busy Robot' },
  { value: 'round_robin', label: 'Round Robin' },
  { value: 'priority_queue', label: 'Priority Queue' },
];

export function useSimulationGrid() {
  const [grid, setGrid] = useState(() => createGrid(DEFAULT_ROWS, DEFAULT_COLS));
  const [activeTool, setActiveTool] = useState(TOOLS.SELECT);
  const [selectedCell, setSelectedCell] = useState(null);
  const [hoveredCell, setHoveredCell] = useState(null);
  const [error, setError] = useState(null);

  // Backend sync: the scheduling strategy is a property of a *saved*
  // warehouse, so switching it from the UI needs this session's grid to
  // exist on the server first.
  const [syncedWarehouseId, setSyncedWarehouseId] = useState(null);
  const [schedulingStrategy, setSchedulingStrategyState] = useState('nearest_robot');
  const [syncStatus, setSyncStatus] = useState('idle'); // idle | syncing | error
  const [syncError, setSyncError] = useState(null);

  // Milestone 13: named, browsable saved layouts. `syncToServer` above
  // (create-or-update against whatever's currently synced) is still how a
  // quick in-progress save works; this is the layer on top that lets the
  // person name a layout, save it as a new one deliberately, and browse
  // back through everything they've saved before.
  const [layoutName, setLayoutName] = useState('');
  const [savedLayouts, setSavedLayouts] = useState([]);
  const [layoutsStatus, setLayoutsStatus] = useState('idle'); // idle | loading | error
  const [layoutsError, setLayoutsError] = useState(null);

  const resize = useCallback((rows, cols) => {
    setGrid((g) => resizeGrid(g, rows, cols));
    setSelectedCell(null);
  }, []);

  const deselectCell = useCallback(() => setSelectedCell(null), []);

  const resetGrid = useCallback(() => {
    setGrid((g) => clearGrid(g));
    setSelectedCell(null);
  }, []);

  const exportJSON = useCallback(() => JSON.stringify(serializeGrid(grid), null, 2), [grid]);

  const importJSON = useCallback((jsonString) => {
    try {
      const parsed = JSON.parse(jsonString);
      setGrid(deserializeGrid(parsed));
      setSelectedCell(null);
      setError(null);
    } catch (err) {
      setError(`Could not load layout: ${err.message}`);
    }
  }, []);

  /** Left-click (no drag) on a cell - meaning depends on the active tool. */
  const handleCellClick = useCallback(
    (x, y) => {
      setGrid((g) => {
        if (!isInBounds(g, x, y)) return g;
        if (activeTool === TOOLS.SELECT) return g;
        const nextType = activeTool === TOOLS.ERASER ? CELL_TYPES.EMPTY : activeTool;
        return setCell(g, x, y, nextType);
      });
      setSelectedCell({ x, y });
    },
    [activeTool]
  );

  /** Continuous paint while dragging with a placement tool active. */
  const handleCellPaint = useCallback(
    (x, y) => {
      if (activeTool === TOOLS.SELECT) return;
      setGrid((g) => {
        if (!isInBounds(g, x, y)) return g;
        const nextType = activeTool === TOOLS.ERASER ? CELL_TYPES.EMPTY : activeTool;
        return setCell(g, x, y, nextType);
      });
    },
    [activeTool]
  );

  /** Right-click always erases, regardless of the active tool. */
  const handleCellErase = useCallback((x, y) => {
    setGrid((g) => (isInBounds(g, x, y) ? setCell(g, x, y, CELL_TYPES.EMPTY) : g));
  }, []);

  const stats = useMemo(() => countCellsByType(grid), [grid]);
  const selectedCellType = selectedCell ? getCell(grid, selectedCell.x, selectedCell.y) : null;

  /** Replaces the grid wholesale (loading a saved layout, or applying a
   * generated one) - unlike resize/reset/import, this also updates which
   * warehouse (if any) is considered "synced", since swapping the grid
   * out from under an existing synced id would silently overwrite that
   * saved layout on the next sync otherwise. */
  const applyGrid = useCallback((newGrid, meta = {}) => {
    setGrid(newGrid);
    setSelectedCell(null);
    setSyncedWarehouseId(meta.warehouseId ?? null);
    if (meta.name !== undefined) setLayoutName(meta.name);
    if (meta.schedulingStrategy) setSchedulingStrategyState(meta.schedulingStrategy);
    setSyncStatus('idle');
    setSyncError(null);
  }, []);

  /** Creates the warehouse on first call, updates it on every call after -
   * one record per session unless saveLayoutAs below is used to branch
   * off a deliberately new one. */
  const syncToServer = useCallback(async () => {
    setSyncStatus('syncing');
    setSyncError(null);
    try {
      const { rows, cols, cells } = serializeGrid(grid);
      if (syncedWarehouseId) {
        await updateWarehouse(syncedWarehouseId, { rows, cols, cells });
      } else {
        const created = await createWarehouse({
          name: layoutName.trim() || `Layout ${new Date().toLocaleString()}`,
          rows,
          cols,
          cells,
          schedulingStrategy,
        });
        setSyncedWarehouseId(created._id);
        setLayoutName(created.name);
      }
      setSyncStatus('idle');
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err.message);
    }
  }, [grid, syncedWarehouseId, schedulingStrategy, layoutName]);

  /** Milestone 13: always creates a brand new warehouse record regardless
   * of whether one's already synced - "Save As" rather than "Save",
   * switching the active session over to the new record afterward. */
  const saveLayoutAs = useCallback(
    async (name) => {
      setSyncStatus('syncing');
      setSyncError(null);
      try {
        const { rows, cols, cells } = serializeGrid(grid);
        const created = await createWarehouse({
          name: (name || '').trim() || `Layout ${new Date().toLocaleString()}`,
          rows,
          cols,
          cells,
          schedulingStrategy,
        });
        setSyncedWarehouseId(created._id);
        setLayoutName(created.name);
        setSyncStatus('idle');
        return created;
      } catch (err) {
        setSyncStatus('error');
        setSyncError(err.message);
        return null;
      }
    },
    [grid, schedulingStrategy]
  );

  /** Fetches a previously saved warehouse and replaces the current grid
   * with it, switching the active session over to that record. */
  const loadLayout = useCallback(
    async (id) => {
      setSyncStatus('syncing');
      setSyncError(null);
      try {
        const doc = await getWarehouse(id);
        applyGrid(deserializeGrid(doc), {
          warehouseId: doc._id,
          name: doc.name,
          schedulingStrategy: doc.schedulingStrategy,
        });
      } catch (err) {
        setSyncStatus('error');
        setSyncError(err.message);
      }
    },
    [applyGrid]
  );

  /** Refreshes the browsable list of every saved layout (most recently
   * updated first - see the backend's default sort on GET /warehouses). */
  const refreshSavedLayouts = useCallback(async () => {
    setLayoutsStatus('loading');
    setLayoutsError(null);
    try {
      const res = await listWarehouses();
      setSavedLayouts(res.data || []);
      setLayoutsStatus('idle');
    } catch (err) {
      setLayoutsStatus('error');
      setLayoutsError(err.message);
    }
  }, []);

  const deleteLayout = useCallback(
    async (id) => {
      setLayoutsError(null);
      try {
        await deleteWarehouse(id);
        setSavedLayouts((prev) => prev.filter((w) => w._id !== id));
        // The layout being edited right now was just deleted server-side -
        // the next sync should create a fresh record rather than PUT
        // against an id that no longer exists.
        if (syncedWarehouseId === id) setSyncedWarehouseId(null);
      } catch (err) {
        setLayoutsError(err.message);
      }
    },
    [syncedWarehouseId]
  );

  /** Switches the scheduling strategy - optimistic locally, reverted if the
   * server rejects it (e.g. the warehouse was deleted server-side). */
  const changeSchedulingStrategy = useCallback(
    async (nextStrategy) => {
      const previous = schedulingStrategy;
      setSchedulingStrategyState(nextStrategy);
      if (!syncedWarehouseId) return; // nothing saved yet - just remember the choice locally
      try {
        await updateWarehouse(syncedWarehouseId, { schedulingStrategy: nextStrategy });
      } catch (err) {
        setSchedulingStrategyState(previous);
        setSyncStatus('error');
        setSyncError(err.message);
      }
    },
    [syncedWarehouseId, schedulingStrategy]
  );

  return {
    grid,
    activeTool,
    setActiveTool,
    selectedCell,
    selectedCellType,
    hoveredCell,
    setHoveredCell,
    error,
    dismissError: () => setError(null),
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
  };
}
