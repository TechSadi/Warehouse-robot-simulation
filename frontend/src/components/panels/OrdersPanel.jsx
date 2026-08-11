import './Panels.css';

const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const STATUS_LABEL = { pending: 'Pending', assigned: 'Assigned', picked_up: 'Picked Up' };
const ACTIVE_STATUSES = ['pending', 'assigned', 'picked_up'];

export default function OrdersPanel({ orders = [] }) {
  const active = orders
    .filter((o) => ACTIVE_STATUSES.includes(o.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  return (
    <section className="panel">
      <p className="eyebrow">Active Orders {active.length > 0 ? `(${active.length})` : ''}</p>
      {active.length === 0 ? (
        <p className="panel__empty-hint">
          No active orders. Generate some from Simulation Controls.
        </p>
      ) : (
        <div className="order-list">
          {active.map((order) => (
            <div key={order._id} className={`order-row order-row--${order.priority}`}>
              <span className={`order-row__priority order-row__priority--${order.priority}`}>
                {PRIORITY_LABEL[order.priority] || order.priority}
              </span>
              <span className="order-row__status">{STATUS_LABEL[order.status] || order.status}</span>
              <span className="order-row__route readout">
                ({order.pickupLocation.x},{order.pickupLocation.y}) → ({order.deliveryLocation.x},{order.deliveryLocation.y})
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
