import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { THEME } from '../../theme.js';
import './Panels.css';

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__label">t={label}s</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: {entry.value}
        </div>
      ))}
    </div>
  );
}

export default function ChartPanel({ history = [] }) {
  const hasData = history.length > 1;

  return (
    <section className="panel">
      <p className="eyebrow">Fleet Activity</p>
      {!hasData ? (
        <p className="panel__empty-hint">Start the simulation to see activity over time.</p>
      ) : (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid stroke={THEME.line} strokeDasharray="3 3" />
              <XAxis dataKey="t" tick={{ fill: THEME.textMuted, fontSize: 10 }} stroke={THEME.line} />
              <YAxis tick={{ fill: THEME.textMuted, fontSize: 10 }} stroke={THEME.line} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="active" name="Active Robots" stroke={THEME.cyan} dot={false} strokeWidth={2} />
              <Line
                type="monotone"
                dataKey="delivered"
                name="Delivered Orders"
                stroke={THEME.success}
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            <span className="chart-legend__item"><i style={{ background: THEME.cyan }} />Active Robots</span>
            <span className="chart-legend__item"><i style={{ background: THEME.success }} />Delivered Orders</span>
          </div>
        </div>
      )}
    </section>
  );
}
