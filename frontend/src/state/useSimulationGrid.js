import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
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
import { describeError } from '../api/errors.js';
import {
  createWarehouse,
  updateWarehouse,
  listWarehouses,
  getWarehouse,
  deleteWarehouse,
} from '../api/client.js';

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

export const SYNC_STATUS = { IDLE: 'idle', SYNCING: 'syncing', SAVED: 'saved', ERROR: 'error' };
export const LAYOUTS_STATUS = { IDLE: 'idle', LOADING: 'loading', ERROR: 'error' };

/** How long a "Saved" confirmation stays up before settling back to idle.
 * Long enough to notice, short enough that it never reads as the permanent
 * state of the button. */
const SAVED_CONFIRMATION_MS = 2000;

/**
 * The warehouse layout being edited, and its relationship to the server.
 *
 * The grid itself is purely local until it is synced: this hook owns the
 * client-side drawing state (grid, active tool, selection, hover) and the
 * small amount of server state that goes with it (which saved warehouse
 * this session is bound to, the list of saved layouts). Live simulation
 * state - robots, orders, obstacles - deliberately lives elsewhere, in
 * useLiveSimulation, and is keyed off `syncedWarehouseId`.
 */
export function useSimulationGrid() {
  const [grid, setGrid] = useState(() => createGrid(DEFAULT_ROWS, DEFAULT_COLS));
  const { rows, cols } = grid;
  const [activeTool, setActiveTool] = useState(TOOLS.SELECT);
  const [selectedCell, setSelectedCell] = useState(null);
  const [hoveredCell, setHoveredCell] = useState(null);
  const [error, setError] = useState(null);

  // Backend sync: the scheduling strategy is a property of a *saved*
  // warehouse, so switching it from the UI needs this session's grid to
  // exist on the server first.
  const [syncedWarehouseId, setSyncedWarehouseId] = useState(null);
  const [schedulingStrategy, setSchedulingStrategyState] = useState('nearest_robot');
  const [syncStatus, setSyncStatus] = useState(SYNC_STATUS.IDLE);
  const [syncError, setSyncError] = useState(null);

  // Named, browsable saved layouts. `syncToServer` (create-or-update
  // against whatever is currently synced) is still how a quick in-progress
  // save works; this is the layer on top that lets the person name a
  // layout, save it as a new one deliberately, and browse back through
  // everything they have saved before.
  const [layoutName, setLayoutName] = useState('');
  const [savedLayouts, setSavedLayouts] = useState([]);
  const [layoutsStatus, setLayoutsStatus] = useState(LAYOUTS_STATUS.IDLE);
  const [layoutsError, setLayoutsError] = useState(null);
  const [deletingLayoutId, setDeletingLayoutId] = useState(null);

  /** Invalidates in-flight layout requests when a newer one supersedes
   * them, so a slow "load layout A" landing after "load layout B" cannot
   * swap the grid out from under the user. */
  const layoutSeq = useRef(0);
  const savedTimer = useRef(null);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  /** Shows a brief "Saved" confirmation, then settles. A save that reports
   * nothing at all leaves the user re-clicking to check it worked. */
  const confirmSaved = useCallback(() => {
    setSyncStatus(SYNC_STATUS.SAVED);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSyncStatus(SYNC_STATUS.IDLE), SAVED_CONFIRMATION_MS);
  }, []);

  const resize = useCallback((rows, cols) => {
    setGrid((g) => resizeGrid(g, rows, cols));
    setSelectedCell(null);
  }, []);

  const deselectCell = useCallback(() => setSelectedCell(null), []);
  const dismissError = useCallback(() => setError(null), []);
  const dismissSyncError = useCallback(() => setSyncError(null), []);

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
      return true;
    } catch (err) {
      setError(`That file isn't a valid layout: ${err.message}`);
      return false;
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

  /**
   * Moves the selected cell by one step, clamped to the grid.
   *
   * This is the keyboard's equivalent of moving the pointer. The grid is a
   * canvas, so there is nothing for the browser to focus per cell and no
   * arrow-key behaviour to inherit - without this, every editing action in
   * the app was reachable only with a mouse. Starting from (0,0) when
   * nothing is selected means the first arrow press does something visible
   * rather than nothing.
   */
  const moveSelection = useCallback(
    (dx, dy) => {
      setSelectedCell((current) => {
        const next = current ? { x: current.x + dx, y: current.y + dy } : { x: 0, y: 0 };
        return {
          x: Math.min(cols - 1, Math.max(0, next.x)),
          y: Math.min(rows - 1, Math.max(0, next.y)),
        };
      });
    },
    [rows, cols]
  );

  const selectCell = useCallback((x, y) => {
    setSelectedCell({ x, y });
  }, []);

  const stats = useMemo(() => countCellsByType(grid), [grid]);
  const selectedCellType = selectedCell ? getCell(grid, selectedCell.x, selectedCell.y) : null;

  /** Replaces the grid wholesale (loading a saved layout, or applying a
   * generated one) - unlike resize/reset/import, this also updates which
   * warehouse (if any) is considered "synced", since swapping the grid out
   * from under an existing synced id would silently overwrite that saved
   * layout on the next sync otherwise. */
  const applyGrid = useCallback((newGrid, meta = {}) => {
    setGrid(newGrid);
    setSelectedCell(null);
    setSyncedWarehouseId((prev) => ('warehouseId' in meta ? meta.warehouseId : prev));
    if (meta.name !== undefined) setLayoutName(meta.name);
    if (meta.schedulingStrategy) setSchedulingStrategyState(meta.schedulingStrategy);
    setSyncStatus(SYNC_STATUS.IDLE);
    setSyncError(null);
  }, []);

  /** Creates the warehouse on first call, updates it on every call after -
   * one record per session unless saveLayoutAs is used to branch off a
   * deliberately new one. */
  const syncToServer = useCallback(async () => {
    setSyncStatus(SYNC_STATUS.SYNCING);
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
      confirmSaved();
      return true;
    } catch (err) {
      setSyncStatus(SYNC_STATUS.ERROR);
      setSyncError(describeError(err));
      return false;
    }
  }, [grid, syncedWarehouseId, schedulingStrategy, layoutName, confirmSaved]);

  /** Always creates a brand new warehouse record regardless of whether one
   * is already synced - "Save As" rather than "Save", switching the active
   * session over to the new record afterward. */
  const saveLayoutAs = useCallback(
    async (name) => {
      setSyncStatus(SYNC_STATUS.SYNCING);
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
        confirmSaved();
        return created;
      } catch (err) {
        setSyncStatus(SYNC_STATUS.ERROR);
        setSyncError(describeError(err));
        return null;
      }
    },
    [grid, schedulingStrategy, confirmSaved]
  );

  /** Fetches a previously saved warehouse and replaces the current grid
   * with it, switching the active session over to that record. */
  const loadLayout = useCallback(
    async (id) => {
      layoutSeq.current += 1;
      const seq = layoutSeq.current;
      setSyncStatus(SYNC_STATUS.SYNCING);
      setSyncError(null);
      try {
        const doc = await getWarehouse(id);
        // A newer load (or a delete) superseded this one while it was in
        // flight; applying it now would contradict what the user last asked
        // for.
        if (seq !== layoutSeq.current) return false;
        applyGrid(deserializeGrid(doc), {
          warehouseId: doc._id,
          name: doc.name,
          schedulingStrategy: doc.schedulingStrategy,
        });
        return true;
      } catch (err) {
        if (seq !== layoutSeq.current) return false;
        setSyncStatus(SYNC_STATUS.ERROR);
        setSyncError(describeError(err));
        return false;
      }
    },
    [applyGrid]
  );

  /** Refreshes the browsable list of every saved layout (most recently
   * updated first - see the backend's default sort on GET /warehouses). */
  const refreshSavedLayouts = useCallback(async () => {
    setLayoutsStatus(LAYOUTS_STATUS.LOADING);
    setLayoutsError(null);
    try {
      const res = await listWarehouses();
      setSavedLayouts(res.data || []);
      setLayoutsStatus(LAYOUTS_STATUS.IDLE);
    } catch (err) {
      setLayoutsStatus(LAYOUTS_STATUS.ERROR);
      setLayoutsError(describeError(err));
    }
  }, []);

  const deleteLayout = useCallback(
    async (id) => {
      setLayoutsError(null);
      setDeletingLayoutId(id);
      try {
        await deleteWarehouse(id);
        setSavedLayouts((prev) => prev.filter((w) => w._id !== id));
        // The layout being edited right now was just deleted server-side -
        // the next sync should create a fresh record rather than PUT
        // against an id that no longer exists.
        setSyncedWarehouseId((current) => (current === id ? null : current));
        return true;
      } catch (err) {
        setLayoutsError(describeError(err));
        return false;
      } finally {
        setDeletingLayoutId(null);
      }
    },
    []
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
        setSyncStatus(SYNC_STATUS.ERROR);
        setSyncError(describeError(err));
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
    selectCell,
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
  };
}
