import { memo, useId } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { THEME } from '../../theme.js';
import { EmptyState } from '../common/Feedback.jsx';
import './Panels.css';

function ChartTooltip({ active = false, payload = null, label = 0 }) {
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

/**
 * Fleet activity over the last minute.
 *
 * Memoised deliberately: this is the most expensive thing on the rail (a
 * recharts render with a ResponsiveContainer and two line series), and its
 * only input changes once a second, while the dashboard around it
 * re-renders on every robot update - roughly twice that. Without the memo
 * it re-rendered every time a robot moved a pixel, for a chart that had not
 * gained a point.
 *
 * A canvas-free summary of the same data is exposed to screen readers,
 * since an SVG line chart is unreadable to one however it is labelled.
 */
function ChartPanel({ history = [] }) {
  const headingId = useId();
  const hasData = history.length > 1;
  const latest = history[history.length - 1];

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Fleet Activity
      </h2>
      {!hasData ? (
        <EmptyState
          title="No activity recorded."
          hint="Start the simulation to chart active robots and delivered orders over time."
        />
      ) : (
        <div className="chart-wrap">
          <div className="chart-canvas" aria-hidden="true">
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid stroke={THEME.line} strokeDasharray="3 3" />
                <XAxis dataKey="t" tick={{ fill: THEME.textMuted, fontSize: 10 }} stroke={THEME.line} />
                <YAxis
                  tick={{ fill: THEME.textMuted, fontSize: 10 }}
                  stroke={THEME.line}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Line
                  type="monotone"
                  dataKey="active"
                  name="Active Robots"
                  stroke={THEME.cyan}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="delivered"
                  name="Delivered Orders"
                  stroke={THEME.success}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend" aria-hidden="true">
            <span className="chart-legend__item">
              <i style={{ background: THEME.cyan }} />
              Active Robots
            </span>
            <span className="chart-legend__item">
              <i style={{ background: THEME.success }} />
              Delivered Orders
            </span>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {`Over the last ${latest.t} seconds: ${latest.active} active robots, ${latest.delivered} delivered orders.`}
          </p>
        </div>
      )}
    </section>
  );
}

export default memo(ChartPanel);
