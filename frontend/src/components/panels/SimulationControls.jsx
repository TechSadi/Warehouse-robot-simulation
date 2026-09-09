import { useId } from 'react';
import { Banner, EmptyState, LoadingState, StatusMessage } from '../common/Feedback.jsx';
import { describeRealtime } from '../../state/useConnection.js';
import { formatPercent, formatRelativeTime, pluralize } from '../../utils/format.js';
import './Panels.css';

/**
 * The live fleet: whether it is running, whether we are still hearing from
 * it, and the four commands that change it.
 *
 * The design problem this solves is that "the simulation is running" and
 * "this browser is receiving updates" are different facts that looked
 * identical before - a Start button that stayed green while the socket was
 * dead, next to robots frozen at their last known positions. Both are
 * stated explicitly, and every command is disabled with a reason when the
 * connection cannot carry it, rather than silently doing nothing.
 */
export default function SimulationControls({
  syncedWarehouseId,
  isRunning,
  isLoading,
  isStale,
  canControl,
  connection,
  syncedAt,
  robotCount,
  activeOrderCount,
  lowBatteryCount,
  avgBattery,
  errorRobotCount,
  pendingAction,
  onStartSimulation,
  onStopSimulation,
  runInBackground,
  onToggleRunInBackground,
  onSpawnRobot,
  onGenerateOrders,
  onDispatchNow,
  showHeatmap,
  onToggleHeatmap,
  onClearHeatmap,
  actionError,
  dismissActionError,
}) {
  const headingId = useId();
  const heatmapId = useId();
  const backgroundId = useId();
  const realtime = describeRealtime(connection);

  if (!syncedWarehouseId) {
    return (
      <section className="panel" aria-labelledby={headingId}>
        <h2 className="eyebrow panel__heading" id={headingId}>
          Simulation
        </h2>
        <EmptyState
          title="No simulation yet."
          hint='Draw a layout, then use "Sync Layout to Server" above. Robots, orders and the live feed all attach to a synced warehouse.'
        />
      </section>
    );
  }

  if (isLoading) {
    return (
      <section className="panel" aria-labelledby={headingId}>
        <h2 className="eyebrow panel__heading" id={headingId}>
          Simulation
        </h2>
        <LoadingState label="Loading fleet, orders and obstacles…" />
      </section>
    );
  }

  const busy = Boolean(pendingAction);
  const controlsDisabledReason = canControl
    ? null
    : 'Waiting for the live connection. Commands are disabled until it is back.';

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Simulation
      </h2>

      {/* The one place that states, unambiguously, whether the simulation is
          running - the button label alone was ambiguous while a command was
          in flight or the socket was down. */}
      <div className={`run-state run-state--${isRunning ? 'running' : 'stopped'}`} role="status" aria-live="polite">
        <span className="run-state__dot" aria-hidden="true" />
        <span className="run-state__label">{isRunning ? 'Simulation running' : 'Simulation stopped'}</span>
        <span className={`run-state__link status-${realtime.tone}`}>{realtime.label}</span>
      </div>

      {isStale ? (
        <Banner tone="warn">
          {realtime.detail}{' '}
          {syncedAt
            ? `Showing the last state received ${formatRelativeTime(syncedAt)}.`
            : 'Nothing has loaded for this warehouse yet.'}
        </Banner>
      ) : null}

      {actionError ? (
        <Banner tone="error" onDismiss={dismissActionError}>
          {actionError}
        </Banner>
      ) : null}

      <dl className="run-summary">
        <div className="run-summary__item">
          <dt>Robots</dt>
          <dd className="readout">{robotCount}</dd>
        </div>
        <div className="run-summary__item">
          <dt>Active orders</dt>
          <dd className="readout">{activeOrderCount}</dd>
        </div>
        <div className="run-summary__item">
          <dt>Avg. battery</dt>
          <dd className="readout">{robotCount > 0 ? formatPercent(avgBattery) : '—'}</dd>
        </div>
      </dl>

      {errorRobotCount > 0 ? (
        <Banner tone="error">
          {pluralize(errorRobotCount, 'robot')} in an error state — check the fleet roster.
        </Banner>
      ) : null}
      {lowBatteryCount > 0 ? (
        <Banner tone="warn">
          {pluralize(lowBatteryCount, 'robot')} low on battery. They will head for a charging station if one exists.
        </Banner>
      ) : null}

      <div className="control-row" role="group" aria-label="Fleet setup">
        <button
          type="button"
          className="panel__button"
          onClick={onSpawnRobot}
          disabled={busy}
          aria-busy={pendingAction === 'spawn'}
        >
          {pendingAction === 'spawn' ? 'Spawning…' : 'Spawn Robot'}
        </button>
        <button
          type="button"
          className="panel__button"
          onClick={() => onGenerateOrders(5)}
          disabled={busy}
          aria-busy={pendingAction === 'orders'}
        >
          {pendingAction === 'orders' ? 'Generating…' : 'Generate Orders'}
        </button>
        <button
          type="button"
          className="panel__button"
          onClick={onDispatchNow}
          disabled={busy || robotCount === 0}
          title={robotCount === 0 ? 'Spawn at least one robot before dispatching orders.' : undefined}
          aria-busy={pendingAction === 'dispatch'}
        >
          {pendingAction === 'dispatch' ? 'Dispatching…' : 'Dispatch Now'}
        </button>
      </div>

      <div className="control-row" role="group" aria-label="Run control">
        {/*
          A simulation normally stops when the last person watching it
          closes their tab - it is a thing being watched, not a background
          job. This is the opt-out, for the cases where it genuinely is
          one: a long soak, a demo left running, a fleet being observed
          from somewhere other than a browser. The server puts a ceiling on
          how long an unattended run lasts, so a forgotten tab cannot tick
          a warehouse for the life of the process.
        */}
        <label className="panel__checkbox" htmlFor={backgroundId}>
          <input
            id={backgroundId}
            type="checkbox"
            checked={Boolean(runInBackground)}
            onChange={(e) => onToggleRunInBackground?.(e.target.checked)}
            // Only meaningful at the moment of starting: flipping it while
            // a loop is already running would suggest it changes that
            // loop, which it does not.
            disabled={isRunning || !canControl}
          />
          Keep running when nobody is watching
        </label>
      </div>

      <div className="control-row" role="group" aria-label="Run control">
        {isRunning ? (
          <button
            type="button"
            className="panel__button panel__button--danger"
            onClick={onStopSimulation}
            disabled={!canControl}
            title={controlsDisabledReason || undefined}
          >
            Stop Simulation
          </button>
        ) : (
          <button
            type="button"
            className="panel__button panel__button--primary"
            onClick={() => onStartSimulation({ background: Boolean(runInBackground) })}
            disabled={!canControl}
            title={controlsDisabledReason || undefined}
          >
            Start Simulation
          </button>
        )}
      </div>

      {controlsDisabledReason ? <StatusMessage tone="warn">{controlsDisabledReason}</StatusMessage> : null}

      <div className="control-row">
        <label className="panel__checkbox" htmlFor={heatmapId}>
          <input
            id={heatmapId}
            type="checkbox"
            checked={showHeatmap}
            onChange={(e) => onToggleHeatmap(e.target.checked)}
          />
          Show traffic heatmap
        </label>
        {showHeatmap ? (
          <button type="button" className="panel__button" onClick={onClearHeatmap}>
            Clear
          </button>
        ) : null}
      </div>

      {robotCount === 0 ? (
        <StatusMessage>
          No robots in this warehouse yet. Spawn one before starting the simulation, or it will run with nothing to do.
        </StatusMessage>
      ) : null}
    </section>
  );
}
