import { TOOLS } from '../../state/useSimulationGrid.js';
import { PLACEABLE_TYPES, cellLabel, cellColor } from '../../engine/grid/cellTypes.js';
import './Sidebar.css';

const STATUS_LABEL = { idle: 'Idle', moving: 'Moving', charging: 'Charging', error: 'Error' };

function RobotRow({ robot }) {
  return (
    <div className={`robot-row robot-row--${robot.status}`}>
      <span className={`robot-row__dot robot-row__dot--${robot.status}`} aria-hidden="true" />
      <div className="robot-row__body">
        <div className="robot-row__top">
          <span className="robot-row__name">{robot.name}</span>
          <span className="robot-row__status">{STATUS_LABEL[robot.status] || robot.status}</span>
        </div>
        <div className="robot-row__battery-track">
          <div
            className="robot-row__battery-fill"
            style={{ width: `${Math.max(0, Math.min(100, robot.battery))}%` }}
          />
        </div>
        <div className="robot-row__meta readout">
          X:{Math.round(robot.position.x)} Y:{Math.round(robot.position.y)} · {Math.round(robot.battery)}%
          {robot.isWaiting ? ' · waiting' : ''}
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({ activeTool, setActiveTool, robots = [] }) {
  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <p className="eyebrow">Fleet Roster {robots.length > 0 ? `(${robots.length})` : ''}</p>
        {robots.length === 0 ? (
          <div className="sidebar__empty">
            <p>No robots spawned yet.</p>
            <p className="sidebar__empty-hint">
              Sync the layout, then use "Spawn Robot" in Simulation Controls.
            </p>
          </div>
        ) : (
          <div className="robot-list">
            {robots.map((robot) => (
              <RobotRow key={robot.id} robot={robot} />
            ))}
          </div>
        )}
      </section>

      <div className="sidebar__divider" />

      <section className="sidebar__section">
        <p className="eyebrow">Tools</p>
        <div className="sidebar__palette">
          <button
            type="button"
            className={`sidebar__palette-item ${activeTool === TOOLS.SELECT ? 'is-active' : ''}`}
            onClick={() => setActiveTool(TOOLS.SELECT)}
          >
            <span className="sidebar__palette-swatch sidebar__palette-swatch--select" aria-hidden="true" />
            Select
          </button>
          <button
            type="button"
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
        <p className="eyebrow">Warehouse Objects</p>
        <div className="sidebar__palette">
          {PLACEABLE_TYPES.map((type) => (
            <button
              type="button"
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
        <p className="sidebar__empty-hint">
          Pick a tool, then click or drag on the grid to place it. Right-click any
          cell to clear it.
        </p>
      </section>
    </aside>
  );
}
