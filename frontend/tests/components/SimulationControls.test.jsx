import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SimulationControls from '../../src/components/panels/SimulationControls.jsx';
import { CONNECTION } from '../../src/api/realtime.js';

const baseProps = {
  syncedWarehouseId: 'w1',
  isRunning: false,
  isLoading: false,
  isStale: false,
  canControl: true,
  connection: { status: CONNECTION.CONNECTED, attempts: 0, error: null },
  syncedAt: Date.now(),
  robotCount: 3,
  activeOrderCount: 2,
  lowBatteryCount: 0,
  avgBattery: 84,
  errorRobotCount: 0,
  pendingAction: null,
  onStartSimulation: vi.fn(),
  onStopSimulation: vi.fn(),
  onSpawnRobot: vi.fn(),
  onGenerateOrders: vi.fn(),
  onDispatchNow: vi.fn(),
  showHeatmap: false,
  onToggleHeatmap: vi.fn(),
  onClearHeatmap: vi.fn(),
  actionError: null,
  dismissActionError: vi.fn(),
};

function renderControls(overrides = {}) {
  const props = { ...baseProps, ...overrides };
  return { props, ...render(<SimulationControls {...props} />) };
}

describe('SimulationControls', () => {
  describe('empty and loading states', () => {
    it('explains what to do first when no warehouse is synced', () => {
      renderControls({ syncedWarehouseId: null });

      expect(screen.getByText(/no simulation yet/i)).toBeInTheDocument();
      expect(screen.getByText(/sync layout to server/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /start simulation/i })).not.toBeInTheDocument();
    });

    it('announces progress while the first snapshot loads', () => {
      renderControls({ isLoading: true });

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(/loading fleet/i);
    });
  });

  describe('run state', () => {
    it('says the simulation is stopped, not just what the button does', () => {
      renderControls({ isRunning: false });

      expect(screen.getByText('Simulation stopped')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /start simulation/i })).toBeEnabled();
    });

    it('says the simulation is running and offers to stop it', () => {
      renderControls({ isRunning: true });

      expect(screen.getByText('Simulation running')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stop simulation/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /start simulation/i })).not.toBeInTheDocument();
    });

    it('shows the live connection state next to the run state', () => {
      renderControls({ connection: { status: CONNECTION.RECONNECTING, attempts: 2, error: null } });

      expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    });
  });

  describe('connection gating', () => {
    it('disables run control and explains why while the connection is down', () => {
      renderControls({
        canControl: false,
        connection: { status: CONNECTION.RECONNECTING, attempts: 1, error: null },
      });

      const start = screen.getByRole('button', { name: /start simulation/i });
      expect(start).toBeDisabled();
      expect(screen.getByText(/commands are disabled until it is back/i)).toBeInTheDocument();
    });

    it('says nothing has loaded when the connection died before the first snapshot', () => {
      renderControls({
        isStale: true,
        syncedAt: null,
        connection: { status: CONNECTION.RECONNECTING, attempts: 1, error: null },
      });

      expect(screen.getByText(/nothing has loaded for this warehouse yet/i)).toBeInTheDocument();
    });

    it('warns that on-screen data is not live, with how old it is', () => {
      renderControls({
        isStale: true,
        syncedAt: Date.now() - 45000,
        connection: { status: CONNECTION.DISCONNECTED, attempts: 0, error: null },
      });

      expect(screen.getByText(/last state received/i)).toHaveTextContent(/1m ago|45s ago/);
    });
  });

  describe('commands', () => {
    it('starts the simulation', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.click(screen.getByRole('button', { name: /start simulation/i }));

      expect(props.onStartSimulation).toHaveBeenCalledTimes(1);
    });

    it('stops the simulation', async () => {
      const user = userEvent.setup();
      const { props } = renderControls({ isRunning: true });

      await user.click(screen.getByRole('button', { name: /stop simulation/i }));

      expect(props.onStopSimulation).toHaveBeenCalledTimes(1);
    });

    it('generates a batch of orders', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.click(screen.getByRole('button', { name: /generate orders/i }));

      expect(props.onGenerateOrders).toHaveBeenCalledWith(5);
    });

    it('refuses to dispatch with no robots, and says so', () => {
      renderControls({ robotCount: 0 });

      const dispatch = screen.getByRole('button', { name: /dispatch now/i });
      expect(dispatch).toBeDisabled();
      expect(dispatch).toHaveAttribute('title', expect.stringMatching(/spawn at least one robot/i));
    });

    it('shows progress on the pending command and blocks the others', () => {
      renderControls({ pendingAction: 'spawn' });

      const spawn = screen.getByRole('button', { name: /spawning/i });
      expect(spawn).toHaveAttribute('aria-busy', 'true');
      expect(spawn).toBeDisabled();
      expect(screen.getByRole('button', { name: /generate orders/i })).toBeDisabled();
    });
  });

  describe('feedback', () => {
    it('shows a dismissible error for a failed action', async () => {
      const user = userEvent.setup();
      const { props } = renderControls({ actionError: 'Too many requests in a row.' });

      expect(screen.getByRole('alert')).toHaveTextContent('Too many requests in a row.');
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      expect(props.dismissActionError).toHaveBeenCalled();
    });

    it('flags robots in an error state', () => {
      renderControls({ errorRobotCount: 2 });

      expect(screen.getByText(/2 robots in an error state/i)).toBeInTheDocument();
    });

    it('flags low batteries with correct singular wording', () => {
      renderControls({ lowBatteryCount: 1 });

      expect(screen.getByText(/1 robot low on battery/i)).toBeInTheDocument();
    });

    it('nudges the user to spawn a robot before starting an empty simulation', () => {
      renderControls({ robotCount: 0 });

      expect(screen.getByText(/no robots in this warehouse yet/i)).toBeInTheDocument();
    });
  });

  describe('heatmap', () => {
    it('toggles the overlay', async () => {
      const user = userEvent.setup();
      const { props } = renderControls();

      await user.click(screen.getByLabelText(/show traffic heatmap/i));

      expect(props.onToggleHeatmap).toHaveBeenCalledWith(true);
    });

    it('offers to clear accumulated traffic only while the overlay is on', async () => {
      const user = userEvent.setup();
      const { rerender, props } = renderControls();
      expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument();

      rerender(<SimulationControls {...props} showHeatmap />);
      await user.click(screen.getByRole('button', { name: /^clear$/i }));

      expect(props.onClearHeatmap).toHaveBeenCalled();
    });
  });
});
