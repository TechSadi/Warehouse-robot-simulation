import { memo, useId } from 'react';
import { StatusMessage } from '../common/Feedback.jsx';
import { formatDimensions, formatPercent, pluralize } from '../../utils/format.js';
import './Panels.css';

function StatTiles({ tiles, label }) {
  return (
    <dl className="stat-grid" aria-label={label}>
      {tiles.map((tile) => (
        <div className="stat-tile" key={tile.label}>
          <dd className="stat-tile__value readout">{tile.value}</dd>
          <dt className="stat-tile__label">{tile.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/**
 * Grid and fleet numbers.
 *
 * Tiles are a definition list rather than a stack of divs: each one is
 * literally a term and its value, and marking it up that way is what lets a
 * screen reader read "Avg. Battery, 64%" instead of two unrelated strings.
 * The value comes before the label in the DOM only visually - the `dt`/`dd`
 * pairing carries the relationship regardless of paint order.
 */
function StatisticsPanel({ grid, stats, robotCounts, orderCounts, avgBattery, utilizationPercent }) {
  const headingId = useId();
  const occupied = Object.values(stats).reduce((sum, n) => sum + n, 0);
  const totalRobots = Object.values(robotCounts).reduce((sum, n) => sum + n, 0);
  const activeOrders = orderCounts.pending + orderCounts.assigned + orderCounts.picked_up;
  const hasFleet = totalRobots > 0;

  const gridTiles = [
    { label: 'Grid Size', value: formatDimensions(grid) },
    { label: 'Occupied Cells', value: occupied },
    { label: 'Shelves', value: stats.shelf || 0 },
    { label: 'Obstacles', value: stats.obstacle || 0 },
  ];

  const fleetTiles = [
    { label: 'Active Robots', value: hasFleet ? robotCounts.moving + robotCounts.charging : '—' },
    { label: 'Idle Robots', value: hasFleet ? robotCounts.idle : '—' },
    { label: 'Avg. Battery', value: hasFleet ? formatPercent(avgBattery) : '—' },
    { label: 'Utilization', value: hasFleet ? formatPercent(utilizationPercent) : '—' },
    { label: 'Pending Orders', value: orderCounts.pending },
    { label: 'Delivered', value: orderCounts.delivered },
  ];

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Grid Statistics
      </h2>
      <StatTiles tiles={gridTiles} label="Grid statistics" />

      <div className="panel__inspector">
        <h3 className="eyebrow panel__heading">Fleet Statistics</h3>
        <StatTiles tiles={fleetTiles} label="Fleet statistics" />
        {hasFleet ? (
          <StatusMessage>{pluralize(activeOrders, 'active order')} in the queue.</StatusMessage>
        ) : (
          <StatusMessage>Spawn a robot to see fleet activity here.</StatusMessage>
        )}
      </div>
    </section>
  );
}

export default memo(StatisticsPanel);
