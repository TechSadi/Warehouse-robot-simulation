import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WarehouseControls from '../../src/components/panels/WarehouseControls.jsx';
import { SYNC_STATUS } from '../../src/state/useSimulationGrid.js';
import { createGrid } from '../../src/engine/grid/gridEngine.js';

const baseProps = {
  grid: createGrid(20, 30),
  onResize: vi.fn(),
  onClear: vi.fn(),
  onExport: vi.fn(() => '{"rows":20,"cols":30,"cells":[]}'),
  onImport: vi.fn(),
  onGenerateLayout: vi.fn(),
  canvasRef: { current: { zoomBy: vi.fn(), resetView: vi.fn() } },
  zoomPercent: 1,
  selectedCell: null,
  selectedCellType: null,
  error: null,
  dismissError: vi.fn(),
  syncedWarehouseId: null,
  syncStatus: SYNC_STATUS.IDLE,
  syncError: null,
  dismissSyncError: vi.fn(),
  onSyncToServer: vi.fn(),
  schedulingStrategy: 'nearest_robot',
  onChangeSchedulingStrategy: vi.fn(),
};

function renderControls(overrides = {}) {
  const props = { ...baseProps, ...overrides, canvasRef: { current: { zoomBy: vi.fn(), resetView: vi.fn() } } };
  return { props, ...render(<WarehouseControls {...props} />) };
}

describe('WarehouseControls', () => {
  describe('grid dimensions', () => {
    it('labels its inputs so they can be found by name, not by position', () => {
      renderControls();

      expect(screen.getByLabelText('Rows')).toHaveValue(20);
      expect(screen.getByLabelText('Cols')).toHaveValue(30);
    });

    it('resizes on submit', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      const rows = screen.getByLabelText('Rows');
      await user.clear(rows);
      await user.type(rows, '12');
      await user.click(screen.getByRole('button', { name: 'Resize' }));

      expect(props.onResize).toHaveBeenCalledWith(12, 30);
    });

    it('follows the grid when it is resized from elsewhere', () => {
      const { props, rerender } = renderControls();

      rerender(<WarehouseControls {...props} grid={createGrid(8, 9)} />);

      expect(screen.getByLabelText('Rows')).toHaveValue(8);
      expect(screen.getByLabelText('Cols')).toHaveValue(9);
    });
  });

  describe('view controls', () => {
    it('gives the zoom buttons accessible names, not bare symbols', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.click(screen.getByRole('button', { name: 'Zoom in' }));
      await user.click(screen.getByRole('button', { name: 'Zoom out' }));

      expect(props.canvasRef.current.zoomBy).toHaveBeenCalledTimes(2);
    });

    it('reports the current zoom level', () => {
      renderControls({ zoomPercent: 1.5 });

      expect(screen.getByText('150%')).toBeInTheDocument();
    });
  });

  describe('cell inspector', () => {
    it('explains how to select a cell when nothing is selected', () => {
      renderControls();

      expect(screen.getByText(/nothing selected/i)).toBeInTheDocument();
    });

    it('reports the selected cell and its type', () => {
      renderControls({ selectedCell: { x: 4, y: 7 }, selectedCellType: 'shelf' });

      expect(screen.getByText(/X:4 Y:7 — Shelf/)).toBeInTheDocument();
    });
  });

  describe('server sync', () => {
    it('offers a first sync, and explains what it unlocks', () => {
      renderControls();

      expect(screen.getByRole('button', { name: /sync layout to server/i })).toBeInTheDocument();
      expect(screen.getByText(/spawn robots, generate orders/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/assignment strategy/i)).not.toBeInTheDocument();
    });

    it('offers a re-sync and the strategy picker once a warehouse exists', () => {
      renderControls({ syncedWarehouseId: 'w1' });

      expect(screen.getByRole('button', { name: /re-sync layout/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/assignment strategy/i)).toHaveValue('nearest_robot');
    });

    it('disables the button and shows progress while syncing', () => {
      renderControls({ syncStatus: SYNC_STATUS.SYNCING });

      expect(screen.getByRole('button', { name: /syncing/i })).toBeDisabled();
    });

    it('confirms a completed save rather than silently returning to idle', () => {
      renderControls({ syncStatus: SYNC_STATUS.SAVED });

      expect(screen.getByText(/saved/i)).toBeInTheDocument();
    });

    it('shows a dismissible sync failure', async () => {
      const user = userEvent.setup();
      const { props } = renderControls({ syncError: "Can't reach the server." });

      expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the server.");
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(props.dismissSyncError).toHaveBeenCalled();
    });

    it('changes the scheduling strategy', async () => {
      const user = userEvent.setup();
      const { props } = renderControls({ syncedWarehouseId: 'w1' });

      await user.selectOptions(screen.getByLabelText(/assignment strategy/i), 'round_robin');

      expect(props.onChangeSchedulingStrategy).toHaveBeenCalledWith('round_robin');
    });
  });

  describe('layout generation and serialization', () => {
    it('generates a layout at the selected density', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.selectOptions(screen.getByLabelText(/layout density/i), 'dense');
      await user.click(screen.getByRole('button', { name: /generate layout/i }));

      expect(props.onGenerateLayout).toHaveBeenCalledWith('dense');
    });

    it('clears the grid', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.click(screen.getByRole('button', { name: /clear grid/i }));

      expect(props.onClear).toHaveBeenCalled();
    });

    it('shows a dismissible error when a layout file will not parse', async () => {
      const user = userEvent.setup();
      const { props } = renderControls({ error: "That file isn't a valid layout: Unexpected token" });

      expect(screen.getByRole('alert')).toHaveTextContent(/isn't a valid layout/);
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(props.dismissError).toHaveBeenCalled();
    });

    it('keeps the file input reachable rather than display:none', () => {
      renderControls();

      // display:none would remove it from the accessibility tree and stop
      // the click-through from the visible Import button working at all.
      expect(screen.getByLabelText(/import a layout json file/i)).toBeInTheDocument();
    });
  });
});
