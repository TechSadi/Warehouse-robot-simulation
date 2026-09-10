import GridCanvas from './GridCanvas.jsx';
import { cellLabel } from '../../engine/grid/cellTypes.js';
import { formatCoords, pluralize } from '../../utils/format.js';
import './SimulationCanvas.css';

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * The floor plan, with the chrome around it that says what the picture
 * means: whether what is drawn is current, and what the pointer is over.
 *
 * The canvas itself is a picture and stays one - a per-cell DOM tree for a
 * 6400-cell grid would be far worse for everyone, including screen-reader
 * users. What it gets instead is a text summary of the fleet next to it
 * (the roster in the sidebar is the accessible view of the same data),
 * which also states whether the simulation is running, and an explicit
 * "stale" badge for data that is no longer live - a state otherwise
 * indistinguishable from a simulation that is simply standing still.
 */
export default function SimulationCanvas({
  canvasRef,
  grid,
  selectedCell,
  selectedCellType,
  hoveredCell,
  setHoveredCell,
  isPaintTool,
  onCellClick,
  onCellPaint,
  onCellErase,
  onMoveSelection,
  onZoomChange,
  robots,
  heatmap,
  heatmapEpoch,
  showHeatmap,
  obstacles,
  pathVisualization,
  pickMode,
  isRunning,
  isStale,
}) {
  const coordCell = hoveredCell || selectedCell;
  const coordType = hoveredCell ? null : selectedCellType;

  return (
    <main className="sim-canvas" id="simulation-grid">
      <div className="sim-canvas__frame">
        {CORNERS.map((corner) => (
          <span key={corner} className={`sim-canvas__tick sim-canvas__tick--${corner}`} aria-hidden="true" />
        ))}

        <div className="sim-canvas__axis-label sim-canvas__axis-label--x" aria-hidden="true">
          X →
        </div>
        <div className="sim-canvas__axis-label sim-canvas__axis-label--y" aria-hidden="true">
          Y ↑
        </div>

        <div className="sim-canvas__badges">
          {isStale ? (
            <span className="sim-canvas__badge sim-canvas__badge--stale">Not live — last known positions</span>
          ) : null}
        </div>

        <GridCanvas
          ref={canvasRef}
          grid={grid}
          selectedCell={selectedCell}
          hoveredCell={hoveredCell}
          isPaintTool={isPaintTool}
          onHoverChange={setHoveredCell}
          onCellClick={onCellClick}
          onCellPaint={onCellPaint}
          onCellErase={onCellErase}
          onZoomChange={onZoomChange}
          onMoveSelection={onMoveSelection}
          robots={robots}
          heatmap={heatmap}
          heatmapEpoch={heatmapEpoch}
          showHeatmap={showHeatmap}
          obstacles={obstacles}
          pathVisualization={pathVisualization}
        />

        {/* Announced to assistive technology; the canvas beside it cannot be. */}
        <p className="sr-only" role="status" aria-live="polite">
          {`Warehouse grid, ${grid.cols} by ${grid.rows} cells, ${pluralize(robots.length, 'robot')}, ` +
            `${pluralize(obstacles.length, 'dynamic obstacle')}. ` +
            `Simulation ${isRunning ? 'running' : 'stopped'}. The fleet roster lists every robot's status and battery.`}
        </p>

        <div className="sim-canvas__readout readout">
          {pickMode ? (
            <span className="sim-canvas__readout-hint">Click a cell to set the {pickMode} node…</span>
          ) : coordCell ? (
            <>
              <span className="sim-canvas__readout-coord">{formatCoords(coordCell)}</span>
              {coordType ? <span className="sim-canvas__readout-type">{cellLabel(coordType)}</span> : null}
            </>
          ) : (
            <span className="sim-canvas__readout-hint">
              Scroll to zoom · drag to pan · click to place · right-click to erase
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
