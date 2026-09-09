import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../src/api/client.js', () => ({
  createWarehouse: vi.fn(),
  updateWarehouse: vi.fn(),
  listWarehouses: vi.fn(),
  getWarehouse: vi.fn(),
  deleteWarehouse: vi.fn(),
  refreshSession: vi.fn(async () => true),
}));

const api = await import('../../src/api/client.js');
const { useSimulationGrid, TOOLS, SYNC_STATUS, LAYOUTS_STATUS } = await import(
  '../../src/state/useSimulationGrid.js'
);

const WAREHOUSE = {
  _id: 'w1',
  name: 'Depot',
  rows: 12,
  cols: 14,
  cells: [{ x: 1, y: 1, type: 'shelf' }],
  schedulingStrategy: 'round_robin',
};

describe('useSimulationGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createWarehouse.mockResolvedValue(WAREHOUSE);
    api.updateWarehouse.mockResolvedValue(WAREHOUSE);
    api.listWarehouses.mockResolvedValue({ data: [WAREHOUSE] });
    api.getWarehouse.mockResolvedValue(WAREHOUSE);
    api.deleteWarehouse.mockResolvedValue({});
  });

  describe('editing', () => {
    it('paints with the active tool and selects the cell', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.SHELF));

      act(() => result.current.handleCellClick(2, 3));

      expect(result.current.grid.cells.get('2:3')).toBe('shelf');
      expect(result.current.selectedCell).toEqual({ x: 2, y: 3 });
    });

    it('selects without painting while the Select tool is active', () => {
      const { result } = renderHook(() => useSimulationGrid());

      act(() => result.current.handleCellClick(2, 3));

      expect(result.current.grid.cells.has('2:3')).toBe(false);
      expect(result.current.selectedCell).toEqual({ x: 2, y: 3 });
    });

    it('erases regardless of the active tool', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.SHELF));
      act(() => result.current.handleCellClick(2, 3));

      act(() => result.current.handleCellErase(2, 3));

      expect(result.current.grid.cells.has('2:3')).toBe(false);
    });

    it('ignores edits outside the grid', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.SHELF));

      act(() => result.current.handleCellPaint(999, 999));

      expect(result.current.grid.cells.size).toBe(0);
    });

    it('counts cells by type for the statistics panel', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.SHELF));
      act(() => result.current.handleCellPaint(0, 0));
      act(() => result.current.handleCellPaint(1, 0));

      expect(result.current.stats).toEqual({ shelf: 2 });
    });
  });

  describe('keyboard cell navigation', () => {
    it('starts at the origin when nothing is selected', () => {
      const { result } = renderHook(() => useSimulationGrid());

      act(() => result.current.moveSelection(1, 0));

      expect(result.current.selectedCell).toEqual({ x: 0, y: 0 });
    });

    it('moves the selection one cell at a time', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.selectCell(3, 3));

      act(() => result.current.moveSelection(1, 0));
      act(() => result.current.moveSelection(0, -1));

      expect(result.current.selectedCell).toEqual({ x: 4, y: 2 });
    });

    it('clamps at every edge rather than wrapping or going negative', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.selectCell(0, 0));
      act(() => result.current.moveSelection(-1, -1));
      expect(result.current.selectedCell).toEqual({ x: 0, y: 0 });

      act(() => result.current.selectCell(result.current.grid.cols - 1, result.current.grid.rows - 1));
      act(() => result.current.moveSelection(1, 1));

      expect(result.current.selectedCell).toEqual({
        x: result.current.grid.cols - 1,
        y: result.current.grid.rows - 1,
      });
    });
  });

  describe('serialization', () => {
    it('round-trips a layout through export and import', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.CHARGING));
      act(() => result.current.handleCellPaint(4, 4));
      const exported = result.current.exportJSON();

      act(() => result.current.resetGrid());
      expect(result.current.grid.cells.size).toBe(0);
      act(() => result.current.importJSON(exported));

      expect(result.current.grid.cells.get('4:4')).toBe('charging');
    });

    it('reports a bad layout file as a dismissible error rather than crashing', () => {
      const { result } = renderHook(() => useSimulationGrid());

      act(() => result.current.importJSON('not json at all'));
      expect(result.current.error).toMatch(/isn't a valid layout/i);

      act(() => result.current.dismissError());
      expect(result.current.error).toBeNull();
    });

    it('keeps in-bounds cells when the grid shrinks', () => {
      const { result } = renderHook(() => useSimulationGrid());
      act(() => result.current.setActiveTool(TOOLS.SHELF));
      act(() => result.current.handleCellPaint(1, 1));
      act(() => result.current.handleCellPaint(25, 15));

      act(() => result.current.resize(10, 10));

      expect(result.current.grid.cells.get('1:1')).toBe('shelf');
      expect(result.current.grid.cells.has('25:15')).toBe(false);
    });
  });

  describe('server sync', () => {
    it('creates a warehouse on first sync and updates it thereafter', async () => {
      const { result } = renderHook(() => useSimulationGrid());

      await act(async () => {
        await result.current.syncToServer();
      });
      expect(api.createWarehouse).toHaveBeenCalledTimes(1);
      expect(result.current.syncedWarehouseId).toBe('w1');

      await act(async () => {
        await result.current.syncToServer();
      });
      expect(api.createWarehouse).toHaveBeenCalledTimes(1);
      expect(api.updateWarehouse).toHaveBeenCalledWith('w1', expect.objectContaining({ rows: 20 }));
    });

    it('confirms a save, then settles back to idle', async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSimulationGrid());

        await act(async () => {
          await result.current.syncToServer();
        });
        expect(result.current.syncStatus).toBe(SYNC_STATUS.SAVED);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(result.current.syncStatus).toBe(SYNC_STATUS.IDLE);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a sync failure in words a person can act on', async () => {
      api.createWarehouse.mockRejectedValue(Object.assign(new Error('Network request failed'), { status: 0 }));
      const { result } = renderHook(() => useSimulationGrid());

      await act(async () => {
        await result.current.syncToServer();
      });

      expect(result.current.syncStatus).toBe(SYNC_STATUS.ERROR);
      expect(result.current.syncError).toMatch(/reach the server/i);

      act(() => result.current.dismissSyncError());
      expect(result.current.syncError).toBeNull();
    });

    it('names an unnamed layout rather than saving a blank', async () => {
      const { result } = renderHook(() => useSimulationGrid());

      await act(async () => {
        await result.current.syncToServer();
      });

      expect(api.createWarehouse.mock.calls[0][0].name).toMatch(/^Layout /);
    });
  });

  describe('saved layouts', () => {
    it('always creates a new record on Save As, even with one already synced', async () => {
      const { result } = renderHook(() => useSimulationGrid());
      await act(async () => {
        await result.current.syncToServer();
      });
      api.createWarehouse.mockClear();

      await act(async () => {
        await result.current.saveLayoutAs('Night shift');
      });

      expect(api.createWarehouse).toHaveBeenCalledWith(expect.objectContaining({ name: 'Night shift' }));
    });

    it('loads a saved layout and adopts its id, name and strategy', async () => {
      const { result } = renderHook(() => useSimulationGrid());

      await act(async () => {
        await result.current.loadLayout('w1');
      });

      expect(result.current.syncedWarehouseId).toBe('w1');
      expect(result.current.layoutName).toBe('Depot');
      expect(result.current.schedulingStrategy).toBe('round_robin');
      expect(result.current.grid.cells.get('1:1')).toBe('shelf');
    });

    it('drops a load that resolves after a newer one', async () => {
      let resolveFirst;
      api.getWarehouse.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
      const { result } = renderHook(() => useSimulationGrid());

      let firstLoad;
      act(() => {
        firstLoad = result.current.loadLayout('w-old');
      });
      await act(async () => {
        await result.current.loadLayout('w1');
      });
      await act(async () => {
        resolveFirst({ ...WAREHOUSE, _id: 'w-old', name: 'Stale' });
        await firstLoad;
      });

      expect(result.current.layoutName).toBe('Depot');
      expect(result.current.syncedWarehouseId).toBe('w1');
    });

    it('lists saved layouts with a loading state in between', async () => {
      const { result } = renderHook(() => useSimulationGrid());

      let refresh;
      act(() => {
        refresh = result.current.refreshSavedLayouts();
      });
      expect(result.current.layoutsStatus).toBe(LAYOUTS_STATUS.LOADING);

      await act(async () => {
        await refresh;
      });
      expect(result.current.savedLayouts).toHaveLength(1);
      expect(result.current.layoutsStatus).toBe(LAYOUTS_STATUS.IDLE);
    });

    it('deleting the open layout unbinds the session so the next sync creates a new record', async () => {
      const { result } = renderHook(() => useSimulationGrid());
      await act(async () => {
        await result.current.syncToServer();
      });
      await act(async () => {
        await result.current.refreshSavedLayouts();
      });

      await act(async () => {
        await result.current.deleteLayout('w1');
      });

      expect(result.current.syncedWarehouseId).toBeNull();
      expect(result.current.savedLayouts).toHaveLength(0);
    });

    it('reports a delete failure without removing the row from the list', async () => {
      api.deleteWarehouse.mockRejectedValue(Object.assign(new Error('Request failed: 403'), { status: 403 }));
      const { result } = renderHook(() => useSimulationGrid());
      await act(async () => {
        await result.current.refreshSavedLayouts();
      });

      await act(async () => {
        await result.current.deleteLayout('w1');
      });

      expect(result.current.layoutsError).toMatch(/access/i);
      expect(result.current.savedLayouts).toHaveLength(1);
    });
  });

  describe('scheduling strategy', () => {
    it('remembers the choice locally before anything is saved', async () => {
      const { result } = renderHook(() => useSimulationGrid());

      await act(async () => {
        await result.current.changeSchedulingStrategy('fcfs');
      });

      expect(result.current.schedulingStrategy).toBe('fcfs');
      expect(api.updateWarehouse).not.toHaveBeenCalled();
    });

    it('persists it once a warehouse exists', async () => {
      const { result } = renderHook(() => useSimulationGrid());
      await act(async () => {
        await result.current.syncToServer();
      });

      await act(async () => {
        await result.current.changeSchedulingStrategy('least_busy');
      });

      expect(api.updateWarehouse).toHaveBeenCalledWith('w1', { schedulingStrategy: 'least_busy' });
    });

    it('rolls back the optimistic switch when the server rejects it', async () => {
      const { result } = renderHook(() => useSimulationGrid());
      await act(async () => {
        await result.current.syncToServer();
      });
      api.updateWarehouse.mockRejectedValue(Object.assign(new Error('Request failed: 404'), { status: 404 }));

      await act(async () => {
        await result.current.changeSchedulingStrategy('priority_queue');
      });

      await waitFor(() => expect(result.current.schedulingStrategy).toBe('nearest_robot'));
      expect(result.current.syncError).toMatch(/no longer exists/i);
    });
  });

  it('keeps its callbacks stable so memoised panels do not re-render for nothing', () => {
    const { result, rerender } = renderHook(() => useSimulationGrid());
    const first = {
      dismissError: result.current.dismissError,
      resize: result.current.resize,
      resetGrid: result.current.resetGrid,
      deselectCell: result.current.deselectCell,
      refreshSavedLayouts: result.current.refreshSavedLayouts,
    };

    rerender();

    expect(result.current.dismissError).toBe(first.dismissError);
    expect(result.current.resize).toBe(first.resize);
    expect(result.current.resetGrid).toBe(first.resetGrid);
    expect(result.current.deselectCell).toBe(first.deselectCell);
    expect(result.current.refreshSavedLayouts).toBe(first.refreshSavedLayouts);
  });
});
