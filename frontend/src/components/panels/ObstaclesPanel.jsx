import { useId, useState } from 'react';
import { EmptyState, StatusMessage } from '../common/Feedback.jsx';
import { OBSTACLE_TYPE_LABEL, formatCoords, pluralize } from '../../utils/format.js';
import './Panels.css';

const OBSTACLE_TYPES = Object.keys(OBSTACLE_TYPE_LABEL);

/**
 * Dynamic obstacles: the human workers, spills and construction zones that
 * appear on the floor at runtime and that robots have to path around.
 *
 * The backend has had `POST/DELETE /warehouses/:id/obstacles` since the
 * obstacle engine landed, and broadcasts `obstacles:changed` to every
 * client watching the warehouse - but nothing in the UI ever called them,
 * so obstacles could only appear if the simulation generated them, and
 * could never be cleared. The floor plan showed them; nothing explained
 * what they were or let anyone place one to see how the fleet reacts.
 *
 * Placement uses the currently selected grid cell rather than a second
 * pick mode: the grid already has a selection concept, and adding a third
 * modal cell-picking interaction (after grid tools and the A* start/goal
 * picker) would be one too many for the same click.
 */
export default function ObstaclesPanel({
  syncedWarehouseId,
  obstacles = [],
  selectedCell,
  pendingAction,
  onAddObstacle,
  onRemoveObstacle,
}) {
  const headingId = useId();
  const typeId = useId();
  const [type, setType] = useState(OBSTACLE_TYPES[0]);
  const busy = pendingAction === 'obstacle';

  if (!syncedWarehouseId) {
    return (
      <section className="panel" aria-labelledby={headingId}>
        <h2 className="eyebrow panel__heading" id={headingId}>
          Dynamic Obstacles
        </h2>
        <EmptyState
          title="Nowhere to place obstacles."
          hint="Sync a layout to the server first, then place obstacles the fleet has to path around."
        />
      </section>
    );
  }

  function handleAdd() {
    if (!selectedCell) return;
    onAddObstacle({
      // The server requires a client-supplied id and rejects duplicates, so
      // it has to be unique per obstacle rather than per cell.
      id: `ui-${selectedCell.x}-${selectedCell.y}-${Date.now().toString(36)}`,
      type,
      cells: [{ x: selectedCell.x, y: selectedCell.y }],
    });
  }

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Dynamic Obstacles {obstacles.length > 0 ? `(${obstacles.length})` : ''}
      </h2>

      <div className="control-row">
        <div className="control-field control-field--wide">
          <label htmlFor={typeId}>Obstacle Type</label>
          <select id={typeId} value={type} onChange={(e) => setType(e.target.value)}>
            {OBSTACLE_TYPES.map((value) => (
              <option key={value} value={value}>
                {OBSTACLE_TYPE_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="panel__button"
          onClick={handleAdd}
          disabled={!selectedCell || busy}
          title={selectedCell ? undefined : 'Select a grid cell first.'}
          aria-busy={busy}
        >
          {busy ? 'Placing…' : 'Place Here'}
        </button>
      </div>

      {selectedCell ? (
        <StatusMessage>
          Will be placed at <span className="readout">{formatCoords(selectedCell)}</span>.
        </StatusMessage>
      ) : (
        <StatusMessage>Select a cell on the grid to choose where the obstacle goes.</StatusMessage>
      )}

      {obstacles.length === 0 ? (
        <EmptyState
          title="No obstacles on the floor."
          hint="The fleet has a clear run. Place one above to watch robots re-plan around it."
        />
      ) : (
        <ul className="obstacle-list">
          {obstacles.map((obstacle) => (
            <li key={obstacle.id} className={`obstacle-row obstacle-row--${obstacle.type}`}>
              <span
                className={`obstacle-row__swatch obstacle-row__swatch--${obstacle.type}`}
                aria-hidden="true"
              />
              <span className="obstacle-row__info">
                <span className="obstacle-row__type">
                  {OBSTACLE_TYPE_LABEL[obstacle.type] || obstacle.type}
                </span>
                <span className="obstacle-row__meta readout">
                  {pluralize(obstacle.cells.length, 'cell')} · {formatCoords(obstacle.cells[0])}
                  {obstacle.remainingSeconds != null
                    ? ` · ${Math.round(obstacle.remainingSeconds)}s left`
                    : ' · permanent'}
                </span>
              </span>
              <button
                type="button"
                className="panel__button panel__button--danger"
                onClick={() => onRemoveObstacle(obstacle.id)}
                disabled={busy}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
