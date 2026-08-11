import GridCanvas from './GridCanvas.jsx';
import { cellLabel } from '../../engine/grid/cellTypes.js';
import './SimulationCanvas.css';

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

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
  onZoomChange,
  robots,
  heatmap,
  showHeatmap,
  obstacles,
  pathVisualization,
  pickMode,
}) {
  const coordCell = hoveredCell || selectedCell;
  const coordType = hoveredCell ? null : selectedCellType;

  return (
    <div className="sim-canvas">
      <div className="sim-canvas__frame">
        {CORNERS.map((corner) => (
          <span key={corner} className={`sim-canvas__tick sim-canvas__tick--${corner}`} />
        ))}

        <div className="sim-canvas__axis-label sim-canvas__axis-label--x">X →</div>
        <div className="sim-canvas__axis-label sim-canvas__axis-label--y">Y ↑</div>

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
          robots={robots}
          heatmap={heatmap}
          showHeatmap={showHeatmap}
          obstacles={obstacles}
          pathVisualization={pathVisualization}
        />

        <div className="sim-canvas__readout readout">
          {pickMode ? (
            <span className="sim-canvas__readout-hint">Click a cell to set the {pickMode} node…</span>
          ) : coordCell ? (
            <>
              <span className="sim-canvas__readout-coord">
                X:{coordCell.x} Y:{coordCell.y}
              </span>
              {coordType ? <span className="sim-canvas__readout-type">{cellLabel(coordType)}</span> : null}
            </>
          ) : (
            <span className="sim-canvas__readout-hint">
              Scroll to zoom · drag to pan · click to place · right-click to erase
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
