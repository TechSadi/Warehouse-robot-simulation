import { memo, useId } from 'react';
import { Banner, EmptyState, StatusMessage } from '../common/Feedback.jsx';
import { formatCoords } from '../../utils/format.js';
import './Panels.css';

const HEURISTICS = [
  { value: 'manhattan', label: 'Manhattan' },
  { value: 'euclidean', label: 'Euclidean' },
  { value: 'diagonal', label: 'Diagonal' },
];

function CellReadout({ label, cell, onClear }) {
  return (
    <div className="viz-cell-readout">
      <span className="viz-cell-readout__label">{label}</span>
      <span className="viz-cell-readout__value">
        <span className="readout">{cell ? formatCoords(cell) : 'Not set'}</span>
        {cell && onClear ? (
          <button
            type="button"
            className="viz-cell-readout__clear"
            onClick={onClear}
            aria-label={`Clear ${label.toLowerCase()} cell`}
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Step-by-step A* visualisation: pick two cells, ask the server for the
 * full search trace, then scrub through it locally.
 *
 * The three states this panel can be in - no warehouse, no trace yet, a
 * trace to scrub - previously looked nearly identical (a paragraph of grey
 * hint text, or nothing at all). They are now distinct, and a search that
 * finds no path says so rather than leaving the controls looking broken.
 */
function AIVisualizationPanel({
  syncedWarehouseId,
  pickMode,
  onPickStart,
  onPickGoal,
  onCancelPick,
  start,
  goal,
  onClearStart,
  onClearGoal,
  heuristic,
  onChangeHeuristic,
  allowDiagonal,
  onChangeAllowDiagonal,
  onRun,
  isRunning,
  runError,
  onDismissRunError,
  result,
  currentStep,
  stepIndex,
  totalSteps,
  onStepForward,
  onStepBackward,
  onPlay,
  onPause,
  isPlaying,
  speedMs,
  onChangeSpeed,
  minSpeedMs,
  maxSpeedMs,
  onReset,
}) {
  const headingId = useId();
  const heuristicId = useId();
  const diagonalId = useId();
  const speedId = useId();

  if (!syncedWarehouseId) {
    return (
      <section className="panel" aria-labelledby={headingId}>
        <h2 className="eyebrow panel__heading" id={headingId}>
          Path Visualisation
        </h2>
        <EmptyState
          title="No warehouse synced."
          hint="Sync a layout to the server to watch A* search it cell by cell."
        />
      </section>
    );
  }

  const canRun = Boolean(start && goal) && !isRunning;
  const hasTrace = totalSteps > 0;
  const atLastStep = stepIndex >= totalSteps - 1;
  const atFirstStep = stepIndex <= 0;
  const noPathFound = Boolean(result) && !result.found;

  const statTiles = result
    ? [
        { label: 'Found', value: result.found ? 'Yes' : 'No' },
        { label: 'Path Cost', value: result.found ? Math.round(result.cost * 100) / 100 : '—' },
        { label: 'Nodes Explored', value: result.nodesExplored },
        { label: 'Execution Time', value: `${result.executionTimeMs.toFixed(2)} ms` },
      ]
    : [];

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Path Visualisation
      </h2>

      {runError ? (
        <Banner tone="error" onDismiss={onDismissRunError}>
          {runError}
        </Banner>
      ) : null}

      <div className="control-row">
        <CellReadout label="Start" cell={start} onClear={onClearStart} />
        <CellReadout label="Goal" cell={goal} onClear={onClearGoal} />
      </div>

      <div className="control-row" role="group" aria-label="Choose start and goal cells">
        <button
          type="button"
          className={`panel__button${pickMode === 'start' ? ' panel__button--active' : ''}`}
          onClick={pickMode === 'start' ? onCancelPick : onPickStart}
          aria-pressed={pickMode === 'start'}
        >
          {pickMode === 'start' ? 'Click a cell…' : 'Pick Start'}
        </button>
        <button
          type="button"
          className={`panel__button${pickMode === 'goal' ? ' panel__button--active' : ''}`}
          onClick={pickMode === 'goal' ? onCancelPick : onPickGoal}
          aria-pressed={pickMode === 'goal'}
        >
          {pickMode === 'goal' ? 'Click a cell…' : 'Pick Goal'}
        </button>
      </div>

      {pickMode ? (
        <StatusMessage tone="info">
          Click any cell on the grid to set the {pickMode} node. Press Escape to cancel.
        </StatusMessage>
      ) : null}

      <div className="control-field control-field--wide">
        <label htmlFor={heuristicId}>Heuristic</label>
        <select id={heuristicId} value={heuristic} onChange={(e) => onChangeHeuristic(e.target.value)}>
          {HEURISTICS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <label className="panel__checkbox" htmlFor={diagonalId}>
        <input
          id={diagonalId}
          type="checkbox"
          checked={allowDiagonal}
          onChange={(e) => onChangeAllowDiagonal(e.target.checked)}
        />
        Allow diagonal movement
      </label>

      <div className="control-row">
        <button
          type="button"
          className="panel__button panel__button--primary"
          onClick={onRun}
          disabled={!canRun}
          aria-busy={isRunning}
          title={!start || !goal ? 'Pick both a start and a goal cell first.' : undefined}
        >
          {isRunning ? 'Searching…' : 'Find Path'}
        </button>
        {hasTrace || result ? (
          <button type="button" className="panel__button" onClick={onReset}>
            Clear
          </button>
        ) : null}
      </div>

      {!result && !hasTrace ? (
        <EmptyState
          title="No search run yet."
          hint="Pick a start and a goal cell, then Find Path to record the search step by step."
        />
      ) : null}

      {noPathFound && !hasTrace ? (
        <EmptyState
          title="No route between those cells."
          hint="One of them may be a shelf, an obstacle, or walled off from the other. Pick two open cells and try again."
        />
      ) : null}

      {noPathFound && hasTrace ? (
        <StatusMessage tone="warn">
          The search explored every reachable cell without finding the goal. Scrub through the steps below to see
          where it ran out of room.
        </StatusMessage>
      ) : null}

      {result?.stepsTruncated ? (
        <StatusMessage>
          This search explored more nodes than the recording keeps — the stats reflect the full search, but scrubbing
          covers only the first {totalSteps} steps.
        </StatusMessage>
      ) : null}

      {statTiles.length > 0 ? (
        <dl className="stat-grid" aria-label="Search results">
          {statTiles.map((stat) => (
            <div className="stat-tile" key={stat.label}>
              <dd className="stat-tile__value readout">{stat.value}</dd>
              <dt className="stat-tile__label">{stat.label}</dt>
            </div>
          ))}
        </dl>
      ) : null}

      {hasTrace ? (
        <div className="panel__inspector">
          <h3 className="eyebrow panel__heading" aria-live="polite">
            Step {stepIndex + 1} / {totalSteps}
          </h3>

          <div className="control-row" role="group" aria-label="Playback">
            <button type="button" className="panel__button" onClick={onStepBackward} disabled={atFirstStep}>
              <span aria-hidden="true">⏮</span> Back
            </button>
            {isPlaying ? (
              <button type="button" className="panel__button" onClick={onPause}>
                <span aria-hidden="true">⏸</span> Pause
              </button>
            ) : (
              <button type="button" className="panel__button" onClick={onPlay}>
                <span aria-hidden="true">▶</span> Play
              </button>
            )}
            <button type="button" className="panel__button" onClick={onStepForward} disabled={atLastStep}>
              Forward <span aria-hidden="true">⏭</span>
            </button>
          </div>

          <div className="control-field control-field--wide">
            <label htmlFor={speedId}>Playback speed ({speedMs} ms/step)</label>
            <input
              id={speedId}
              type="range"
              min={minSpeedMs}
              max={maxSpeedMs}
              step={50}
              // Inverted so dragging right feels faster, which is what a
              // speed slider is expected to do.
              value={maxSpeedMs + minSpeedMs - speedMs}
              onChange={(e) => onChangeSpeed(maxSpeedMs + minSpeedMs - Number(e.target.value))}
            />
          </div>

          {currentStep ? (
            <dl className="stat-grid" aria-label="Current search step">
              <div className="stat-tile">
                <dd className="stat-tile__value readout">{formatCoords(currentStep.current)}</dd>
                <dt className="stat-tile__label">Current Node</dt>
              </div>
              <div className="stat-tile">
                <dd className="stat-tile__value readout">
                  g:{Math.round(currentStep.current.g * 100) / 100} h:
                  {Math.round(currentStep.current.h * 100) / 100} f:
                  {Math.round(currentStep.current.f * 100) / 100}
                </dd>
                <dt className="stat-tile__label">g / h / f</dt>
              </div>
              <div className="stat-tile">
                <dd className="stat-tile__value readout">{currentStep.openSet.length}</dd>
                <dt className="stat-tile__label">Open Set</dt>
              </div>
              <div className="stat-tile">
                <dd className="stat-tile__value readout">{currentStep.closedSet.length}</dd>
                <dt className="stat-tile__label">Closed Set</dt>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default memo(AIVisualizationPanel);
