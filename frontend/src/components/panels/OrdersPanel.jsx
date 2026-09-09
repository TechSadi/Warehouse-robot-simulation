import { memo, useId, useMemo } from 'react';
import { EmptyState, LoadingState } from '../common/Feedback.jsx';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_PRIORITY_LABEL,
  ORDER_STATUS_LABEL,
  pluralize,
} from '../../utils/format.js';
import './Panels.css';

const MAX_VISIBLE = 8;
/** Urgent first, so the thing most likely to need attention is at the top
 * rather than merely the most recently created. */
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function OrdersPanel({ orders = [], isLoading = false, deliveredCount = 0 }) {
  const headingId = useId();

  const active = useMemo(() => {
    return orders
      .filter((order) => ACTIVE_ORDER_STATUSES.includes(order.status))
      .sort((a, b) => {
        const byPriority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
        if (byPriority !== 0) return byPriority;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [orders]);

  const visible = active.slice(0, MAX_VISIBLE);
  const hidden = active.length - visible.length;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 className="eyebrow panel__heading" id={headingId}>
        Active Orders {active.length > 0 ? `(${active.length})` : ''}
      </h2>

      {isLoading && orders.length === 0 ? <LoadingState label="Loading orders…" /> : null}

      {!isLoading && active.length === 0 ? (
        <EmptyState
          title={
            deliveredCount > 0
              ? `Nothing in the queue — ${pluralize(deliveredCount, 'order')} delivered.`
              : 'No orders yet.'
          }
          hint={
            deliveredCount > 0
              ? 'Generate more orders from Simulation to keep the fleet busy.'
              : 'Use "Generate Orders" in Simulation, then "Dispatch Now" to assign them to robots.'
          }
        />
      ) : null}

      {active.length > 0 ? (
        <>
          <ul className="order-list">
            {visible.map((order) => (
              <li key={order._id} className={`order-row order-row--${order.priority}`}>
                <span className={`order-row__priority order-row__priority--${order.priority}`}>
                  {ORDER_PRIORITY_LABEL[order.priority] || order.priority}
                </span>
                <span className="order-row__status">
                  {ORDER_STATUS_LABEL[order.status] || order.status}
                </span>
                <span className="order-row__route readout">
                  ({order.pickupLocation.x},{order.pickupLocation.y}){' '}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only"> to </span> ({order.deliveryLocation.x},
                  {order.deliveryLocation.y})
                </span>
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <p className="panel__footnote">{pluralize(hidden, 'more order')} not shown.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default memo(OrdersPanel);
