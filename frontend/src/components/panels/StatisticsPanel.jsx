import './Panels.css';

export default function StatisticsPanel({ grid, stats, robotCounts, orderCounts, avgBattery, utilizationPercent }) {
  const occupied = Object.values(stats).reduce((sum, n) => sum + n, 0);
  const totalRobots = Object.values(robotCounts).reduce((sum, n) => sum + n, 0);
  const activeOrders = orderCounts.pending + orderCounts.assigned + orderCounts.picked_up;

  const gridTiles = [
    { label: 'Grid Size', value: `${grid.cols}×${grid.rows}` },
    { label: 'Occupied Cells', value: occupied },
    { label: 'Shelves', value: stats.shelf || 0 },
    { label: 'Obstacles', value: stats.obstacle || 0 },
  ];

  const fleetTiles = [
    { label: 'Active Robots', value: totalRobots > 0 ? robotCounts.moving + robotCounts.charging : '—' },
    { label: 'Idle Robots', value: totalRobots > 0 ? robotCounts.idle : '—' },
    { label: 'Avg. Battery', value: totalRobots > 0 ? `${Math.round(avgBattery)}%` : '—' },
    { label: 'Utilization', value: totalRobots > 0 ? `${Math.round(utilizationPercent)}%` : '—' },
    { label: 'Pending Orders', value: orderCounts.pending },
    { label: 'Delivered', value: orderCounts.delivered },
  ];

  return (
    <section className="panel">
      <p className="eyebrow">Grid Statistics</p>
      <div className="stat-grid">
        {gridTiles.map((stat) => (
          <div className="stat-tile" key={stat.label}>
            <span className="stat-tile__value readout">{stat.value}</span>
            <span className="stat-tile__label">{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="panel__inspector">
        <p className="eyebrow">Fleet Statistics</p>
        <div className="stat-grid">
          {fleetTiles.map((stat) => (
            <div className="stat-tile" key={stat.label}>
              <span className="stat-tile__value readout">{stat.value}</span>
              <span className="stat-tile__label">{stat.label}</span>
            </div>
          ))}
        </div>
        {totalRobots === 0 ? (
          <p className="panel__empty-hint">Spawn a robot to see fleet activity here.</p>
        ) : null}
        {activeOrders > 0 || totalRobots > 0 ? (
          <p className="panel__empty-hint">
            {activeOrders} active order{activeOrders === 1 ? '' : 's'} in the queue.
          </p>
        ) : null}
      </div>
    </section>
  );
}
