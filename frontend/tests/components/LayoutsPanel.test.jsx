import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LayoutsPanel from '../../src/components/panels/LayoutsPanel.jsx';
import LogsPanel from '../../src/components/panels/LogsPanel.jsx';
import { LAYOUTS_STATUS, SYNC_STATUS } from '../../src/state/useSimulationGrid.js';

vi.mock('../../src/api/client.js', () => ({
  listLogs: vi.fn(),
  refreshSession: vi.fn(async () => true),
}));

const api = await import('../../src/api/client.js');

const layout = (id, overrides = {}) => ({
  _id: id,
  name: `Layout ${id}`,
  rows: 10,
  cols: 20,
  updatedAt: '2026-01-01T10:00:00Z',
  ...overrides,
});

function renderLayouts(overrides = {}) {
  const props = {
    layoutName: 'Depot',
    onChangeLayoutName: vi.fn(),
    syncedWarehouseId: null,
    syncStatus: SYNC_STATUS.IDLE,
    onSaveLayoutAs: vi.fn(),
    savedLayouts: [],
    layoutsStatus: LAYOUTS_STATUS.IDLE,
    layoutsError: null,
    onRefreshLayouts: vi.fn(),
    onLoadLayout: vi.fn(),
    onDeleteLayout: vi.fn(),
    deletingLayoutId: null,
    ...overrides,
  };
  return { props, ...render(<LayoutsPanel {...props} />) };
}

describe('LayoutsPanel', () => {
  it('only fetches the list when the browser is actually opened', async () => {
    const user = userEvent.setup();
    const { props } = renderLayouts();
    expect(props.onRefreshLayouts).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /browse saved/i }));

    expect(props.onRefreshLayouts).toHaveBeenCalledTimes(1);
  });

  it('marks the browse toggle as expandable for assistive technology', async () => {
    const user = userEvent.setup();
    renderLayouts();
    const toggle = screen.getByRole('button', { name: /browse saved/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(screen.getByRole('button', { name: /hide browser/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows an empty state that names the way out of it', async () => {
    const user = userEvent.setup();
    renderLayouts({ savedLayouts: [] });

    await user.click(screen.getByRole('button', { name: /browse saved/i }));

    expect(screen.getByText(/no saved layouts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/give this layout a name above/i)).toBeInTheDocument();
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    const { props } = renderLayouts({
      layoutsStatus: LAYOUTS_STATUS.ERROR,
      layoutsError: "Can't reach the server.",
    });

    await user.click(screen.getByRole('button', { name: /browse saved/i }));
    props.onRefreshLayouts.mockClear();

    expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the server.");
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(props.onRefreshLayouts).toHaveBeenCalled();
  });

  it('marks which saved layout is currently open', async () => {
    const user = userEvent.setup();
    renderLayouts({ savedLayouts: [layout('a'), layout('b')], syncedWarehouseId: 'b' });

    await user.click(screen.getByRole('button', { name: /browse saved/i }));

    expect(screen.getByText('Open')).toBeInTheDocument();
    // Dimensions read columns-by-rows, alongside the last-updated time.
    expect(screen.getAllByText(/^20×10 · /)).toHaveLength(2);
  });

  it('loads a saved layout', async () => {
    const user = userEvent.setup();
    const { props } = renderLayouts({ savedLayouts: [layout('a')] });
    await user.click(screen.getByRole('button', { name: /browse saved/i }));

    await user.click(screen.getByRole('button', { name: 'Load' }));

    expect(props.onLoadLayout).toHaveBeenCalledWith('a');
  });

  describe('deleting', () => {
    it('asks before deleting, and does nothing until confirmed', async () => {
      const user = userEvent.setup();
      const { props } = renderLayouts({ savedLayouts: [layout('a')] });
      await user.click(screen.getByRole('button', { name: /browse saved/i }));

      await user.click(screen.getByRole('button', { name: /delete layout layout a/i }));

      expect(props.onDeleteLayout).not.toHaveBeenCalled();
      expect(screen.getByText('Delete?')).toBeInTheDocument();
    });

    it('deletes once confirmed', async () => {
      const user = userEvent.setup();
      const { props } = renderLayouts({ savedLayouts: [layout('a')] });
      await user.click(screen.getByRole('button', { name: /browse saved/i }));
      await user.click(screen.getByRole('button', { name: /delete layout layout a/i }));

      await user.click(screen.getByRole('button', { name: /yes, delete/i }));

      expect(props.onDeleteLayout).toHaveBeenCalledWith('a');
    });

    it('can be backed out of', async () => {
      const user = userEvent.setup();
      const { props } = renderLayouts({ savedLayouts: [layout('a')] });
      await user.click(screen.getByRole('button', { name: /browse saved/i }));
      await user.click(screen.getByRole('button', { name: /delete layout layout a/i }));

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(props.onDeleteLayout).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Load' })).toBeInTheDocument();
    });
  });

  it('shows progress while saving and refuses a second click', () => {
    renderLayouts({ syncStatus: SYNC_STATUS.SYNCING });

    const save = screen.getByRole('button', { name: /saving/i });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('aria-busy', 'true');
  });

  it('saves under the entered name', async () => {
    const user = userEvent.setup();
    const { props } = renderLayouts({ layoutName: 'Night shift' });

    await user.click(screen.getByRole('button', { name: /save as new/i }));

    expect(props.onSaveLayoutAs).toHaveBeenCalledWith('Night shift');
  });
});

describe('LogsPanel', () => {
  it('loads logs on mount and lists them with source and time', async () => {
    api.listLogs.mockResolvedValue({
      data: [{ _id: 'l1', level: 'warn', message: 'Robot 3 stalled', source: 'tickRunner', createdAt: '2026-01-01T10:00:00Z' }],
    });

    render(<LogsPanel syncedWarehouseId="w1" />);

    expect(await screen.findByText(/robot 3 stalled/i)).toBeInTheDocument();
    expect(screen.getByText(/tickRunner/)).toBeInTheDocument();
    expect(api.listLogs).toHaveBeenCalledWith({ warehouseId: 'w1' });
  });

  it('scopes logs to a level filter', async () => {
    const user = userEvent.setup();
    api.listLogs.mockResolvedValue({ data: [] });
    render(<LogsPanel syncedWarehouseId="w1" />);
    await screen.findByText(/no log entries yet/i);

    await user.selectOptions(screen.getByLabelText('Level'), 'error');

    await waitFor(() =>
      expect(api.listLogs).toHaveBeenLastCalledWith({ warehouseId: 'w1', level: 'error' })
    );
  });

  it('explains that logs are unscoped without a synced warehouse', async () => {
    api.listLogs.mockResolvedValue({ data: [] });

    render(<LogsPanel syncedWarehouseId={null} />);

    expect(await screen.findByText(/across every warehouse/i)).toBeInTheDocument();
    expect(api.listLogs).toHaveBeenCalledWith({});
  });

  it('offers a retry when the request fails', async () => {
    const user = userEvent.setup();
    api.listLogs.mockRejectedValue(Object.assign(new Error('Request failed: 503'), { status: 503 }));
    render(<LogsPanel syncedWarehouseId="w1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/temporarily unavailable/i);

    api.listLogs.mockResolvedValue({ data: [] });
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText(/no log entries yet/i)).toBeInTheDocument();
  });

  it('names the severity for screen readers, since the dot is colour only', async () => {
    api.listLogs.mockResolvedValue({
      data: [{ _id: 'l1', level: 'error', message: 'Boom', source: 'engine', createdAt: null }],
    });

    render(<LogsPanel syncedWarehouseId="w1" />);

    expect(await screen.findByText('error:')).toBeInTheDocument();
  });
});
