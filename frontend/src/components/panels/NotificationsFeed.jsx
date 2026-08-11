import './Panels.css';

/**
 * Milestone 11: surfaces the `notification` events broadcast over
 * Socket.IO (robot errors, order deliveries, unreachable-delivery
 * warnings - see backend/src/services/tickRunner.js and orderService.js)
 * as a small live feed. Deliberately minimal - a fuller notification
 * system (persistence, sound, per-type preferences) is explicitly
 * Milestone 13's job; this just proves the transport works end to end and
 * gives the person watching the dashboard something to glance at.
 */
export default function NotificationsFeed({ notifications = [], onDismiss }) {
  return (
    <section className="panel">
      <p className="eyebrow">Live Activity {notifications.length > 0 ? `(${notifications.length})` : ''}</p>
      {notifications.length === 0 ? (
        <p className="panel__empty-hint">
          Robot errors, deliveries, and other real-time events will show up here once the simulation is running.
        </p>
      ) : (
        <div className="notification-list">
          {notifications.map((n) => (
            <div key={n.id} className={`notification-row notification-row--${n.level || 'info'}`}>
              <span className={`notification-row__dot notification-row__dot--${n.level || 'info'}`} aria-hidden="true" />
              <span className="notification-row__message">{n.message}</span>
              <button
                type="button"
                className="notification-row__dismiss"
                onClick={() => onDismiss?.(n.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
