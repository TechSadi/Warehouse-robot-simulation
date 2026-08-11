import './Panels.css';

const HEURISTICS = [
  { value: 'manhattan', label: 'Manhattan' },
  { value: 'euclidean', label: 'Euclidean' },
  { value: 'diagonal', label: 'Diagonal' },
];

function CellReadout({ label, cell }) {
  return (
    <div className="viz-cell-readout">
      <span className="viz-cell-readout__label">{label}</span>
      <span className="readout">{cell ? `X:${cell.x} Y:${cell.y}` : 'Not set'}</span>
    </div>
  );
}

export default function AIVisualizationPanel({
  syncedWarehouseId,
  pickMode,
  onPickStart,
  onPickGoal,
  onCancelPick,
  start,
  goal,
  heuristic,
  onChangeHeuristic,
  allowDiagonal,
  onChangeAllowDiagonal,
  onRun,
  isRunning,
  runError,
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
  if (!syncedWarehouseId) {
    return (
      <section className="panel">
        <p className="eyebrow">AI Visualisation</p>
        <p className="panel__empty-hint">Sync the layout to the server to visualize how A* searches it.</p>
      </section>
    );
  }

  const canRun = Boolean(start && goal) && !isRunning;
  const hasTrace = totalSteps > 0;
  const atLastStep = stepIndex >= totalSteps - 1;
  const atFirstStep = stepIndex <= 0;

  const statTiles = result
    ? [
        { label: 'Found', value: result.found ? 'Yes' : 'No' },
        { label: 'Path Cost', value: result.found ? Math.round(result.cost * 100) / 100 : '—' },
        { label: 'Nodes Explored', value: result.nodesExplored },
        { label: 'Execution Time', value: `${result.executionTimeMs.toFixed(2)} ms` },
      ]
    : [];

  return (
    <section className="panel">
      <p className="eyebrow">AI Visualisation</p>

      {runError ? <p className="panel__empty-hint panel__empty-hint--error">{runError}</p> : null}

      <div className="control-row">
        <CellReadout label="Start" cell={start} />
        <CellReadout label="Goal" cell={goal} />
      </div>

      <div className="control-row">
        <button
          type="button"
          className={`panel__button${pickMode === 'start' ? ' panel__button--active' : ''}`}
          onClick={pickMode === 'start' ? onCancelPick : onPickStart}
        >
          {pickMode === 'start' ? 'Click a cell…' : 'Pick Start'}
        </button>
        <button
          type="button"
          className={`panel__button${pickMode === 'goal' ? ' panel__button--active' : ''}`}
          onClick={pickMode === 'goal' ? onCancelPick : onPickGoal}
        >
          {pickMode === 'goal' ? 'Click a cell…' : 'Pick Goal'}
        </button>
      </div>

      <label className="control-field control-field--wide">
        <span>Heuristic</span>
        <select value={heuristic} onChange={(e) => onChangeHeuristic(e.target.value)}>
          {HEURISTICS.map((h) => (
            <option key={h.value} value={h.value}>
              {h.label}
            </option>
          ))}
        </select>
      </label>

      <label className="panel__checkbox">
        <input type="checkbox" checked={allowDiagonal} onChange={(e) => onChangeAllowDiagonal(e.target.checked)} />
        Allow diagonal movement
      </label>

      <div className="control-row">
        <button type="button" className="panel__button" onClick={onRun} disabled={!canRun}>
          {isRunning ? 'Finding…' : 'Find Path'}
        </button>
        {hasTrace ? (
          <button type="button" className="panel__button" onClick={onReset}>
            Clear
          </button>
        ) : null}
      </div>

      {result && !hasTrace ? (
        <p className="panel__empty-hint">Start or goal isn't a walkable cell - pick two open cells and try again.</p>
      ) : null}

      {result && result.stepsTruncated ? (
        <p className="panel__empty-hint">
          This search explored more nodes than the recording keeps - stats above reflect the full search, but
          scrubbing only covers the first {totalSteps} steps.
        </p>
      ) : null}

      {statTiles.length > 0 ? (
        <div className="stat-grid">
          {statTiles.map((stat) => (
            <div className="stat-tile" key={stat.label}>
              <span className="stat-tile__value readout">{stat.value}</span>
              <span className="stat-tile__label">{stat.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {hasTrace ? (
        <div className="panel__inspector">
          <p className="eyebrow">
            Step {stepIndex + 1} / {totalSteps}
          </p>

          <div className="control-row">
            <button type="button" className="panel__button" onClick={onStepBackward} disabled={atFirstStep}>
              ⏮ Back
            </button>
            {isPlaying ? (
              <button type="button" className="panel__button" onClick={onPause}>
                ⏸ Pause
              </button>
            ) : (
              <button type="button" className="panel__button" onClick={onPlay}>
                ▶ Play
              </button>
            )}
            <button type="button" className="panel__button" onClick={onStepForward} disabled={atLastStep}>
              Forward ⏭
            </button>
          </div>

          <label className="control-field control-field--wide">
            <span>Playback speed ({speedMs} ms/step)</span>
            <input
              type="range"
              min={minSpeedMs}
              max={maxSpeedMs}
              step={50}
              value={maxSpeedMs + minSpeedMs - speedMs} // slider feels faster-to-the-right
              onChange={(e) => onChangeSpeed(maxSpeedMs + minSpeedMs - Number(e.target.value))}
            />
          </label>

          {currentStep ? (
            <div className="stat-grid">
              <div className="stat-tile">
                <span className="stat-tile__value readout">
                  X:{currentStep.current.x} Y:{currentStep.current.y}
                </span>
                <span className="stat-tile__label">Current Node</span>
              </div>
              <div className="stat-tile">
                <span className="stat-tile__value readout">
                  g:{Math.round(currentStep.current.g * 100) / 100} h:{Math.round(currentStep.current.h * 100) / 100}{' '}
                  f:{Math.round(currentStep.current.f * 100) / 100}
                </span>
                <span className="stat-tile__label">g / h / f</span>
              </div>
              <div className="stat-tile">
                <span className="stat-tile__value readout">{currentStep.openSet.length}</span>
                <span className="stat-tile__label">Open Set</span>
              </div>
              <div className="stat-tile">
                <span className="stat-tile__value readout">{currentStep.closedSet.length}</span>
                <span className="stat-tile__label">Closed Set</span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
