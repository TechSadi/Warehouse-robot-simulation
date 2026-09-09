import { memo } from 'react';
import { TOOLS } from '../../state/useSimulationGrid.js';
import { PLACEABLE_TYPES, cellLabel, cellColor } from '../../engine/grid/cellTypes.js';
import { EmptyState, LoadingState } from '../common/Feedback.jsx';
import {
  ROBOT_STATUS_LABEL,
  batteryTone,
  formatCoords,
  formatPercent,
} from '../../utils/format.js';
import './Sidebar.css';

/**
 * One robot in the roster.
 *
 * Status, battery and position are all readable without colour: the status
 * word is written out, the battery percentage is printed next to its bar,
 * and the bar itself carries `role="progressbar"` with a value - a colour
 * change alone would leave a colour-blind or screen-reader user with
 * nothing.
 */
function RobotRow({ robot }) {
  const battery = Math.max(0, Math.min(100, robot.battery));
  const tone = batteryTone(battery);
  const status = ROBOT_STATUS_LABEL[robot.status] || robot.status;

  return (
    <li className={`robot-row robot-row--${robot.status}`}>
      <span className={`robot-row__dot robot-row__dot--${robot.status}`} aria-hidden="true" />
      <div className="robot-row__body">
        <div className="robot-row__top">
          <span className="robot-row__name">{robot.name}</span>
          <span className={`robot-row__status robot-row__status--${robot.status}`}>{status}</span>
        </div>
        <div
          className="robot-row__battery-track"
          role="progressbar"
          aria-valuenow={Math.round(battery)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${robot.name} battery`}
        >
          <div className={`robot-row__battery-fill robot-row__battery-fill--${tone}`} style={{ width: `${battery}%` }} />
        </div>
        <div className="robot-row__meta readout">
          {formatCoords(robot.position)} · {formatPercent(battery)}
          {robot.isWaiting ? ' · waiting' : ''}
        </div>
      </div>
    </li>
  );
}

/**
 * Fleet roster and the drawing tools.
 *
 * A `<nav>`-less `<aside>` on purpose - these are controls, not navigation,
 * and labelling them as navigation would put them in a screen reader's
 * landmark list under a promise the panel does not keep.
 */
function Sidebar({ activeTool, setActiveTool, robots = [], isLoading = false, hasWarehouse = false }) {
  return (
    <aside className="sidebar" aria-label="Fleet and tools">
      <section className="sidebar__section">
        <h2 className="eyebrow">Fleet Roster {robots.length > 0 ? `(${robots.length})` : ''}</h2>

        {isLoading ? <LoadingState label="Loading fleet…" /> : null}

        {!isLoading && robots.length === 0 ? (
          <EmptyState
            title="No robots yet."
            hint={
              hasWarehouse
                ? 'Use "Spawn Robot" in Simulation to add one to the floor.'
                : 'Sync the layout to the server first, then spawn robots from Simulation.'
            }
          />
        ) : null}

        {robots.length > 0 ? (
          <ul className="robot-list">
            {robots.map((robot) => (
              <RobotRow key={robot.id} robot={robot} />
            ))}
          </ul>
        ) : null}
      </section>

      <div className="sidebar__divider" />

      <section className="sidebar__section">
        <h2 className="eyebrow">Tools</h2>
        <div className="sidebar__palette" role="radiogroup" aria-label="Drawing tool">
          <button
            type="button"
            role="radio"
            aria-checked={activeTool === TOOLS.SELECT}
            className={`sidebar__palette-item ${activeTool === TOOLS.SELECT ? 'is-active' : ''}`}
            onClick={() => setActiveTool(TOOLS.SELECT)}
          >
            <span className="sidebar__palette-swatch sidebar__palette-swatch--select" aria-hidden="true" />
            Select
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={activeTool === TOOLS.ERASER}
            className={`sidebar__palette-item ${activeTool === TOOLS.ERASER ? 'is-active' : ''}`}
            onClick={() => setActiveTool(TOOLS.ERASER)}
          >
            <span className="sidebar__palette-swatch sidebar__palette-swatch--eraser" aria-hidden="true" />
            Eraser
          </button>
        </div>
      </section>

      <div className="sidebar__divider" />

      <section className="sidebar__section">
        <h2 className="eyebrow">Warehouse Objects</h2>
        <div className="sidebar__palette" role="radiogroup" aria-label="Warehouse object to place">
          {PLACEABLE_TYPES.map((type) => (
            <button
              type="button"
              role="radio"
              aria-checked={activeTool === type}
              key={type}
              className={`sidebar__palette-item ${activeTool === type ? 'is-active' : ''}`}
              onClick={() => setActiveTool(type)}
            >
              <span
                className="sidebar__palette-swatch"
                style={{ background: cellColor(type) }}
                aria-hidden="true"
              />
              {cellLabel(type)}
            </button>
          ))}
        </div>
        <p className="sidebar__hint">
          Pick a tool, then click or drag on the grid to place it. Right-click any cell to clear it.
        </p>
      </section>
    </aside>
  );
}

export default memo(Sidebar);
