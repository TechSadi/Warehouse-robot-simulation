import { memo, useId } from 'react';
import { EmptyState } from '../common/Feedback.jsx';
import { formatTime } from '../../utils/format.js';
import './Panels.css';

const LEVEL_DESCRIPTION = { info: 'Info', warn: 'Warning', error: 'Error' };

/**
 * The `notification` events broadcast over Socket.IO - robot errors, order
 * deliveries, unreachable-delivery warnings (see
 * backend/src/services/tickRunner.js and orderService.js) - as a live feed.
 *
 * The list is an `aria-live` region so a screen-reader user hears a robot
 * failing rather than only seeing it. `polite` and not `assertive`: these
 * arrive during a running simulation at a rate that would make an assertive
 * region talk over everything else the user is doing.
 */
function NotificationsFeed({ notifications = [], onDismiss, onClearAll }) {
  const headingId = useId();

  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel__header">
        <h2 className="eyebrow panel__heading" id={headingId}>
          Live Activity {notifications.length > 0 ? `(${notifications.length})` : ''}
        </h2>
        {notifications.length > 0 ? (
          <button type="button" className="panel__button panel__button--quiet" onClick={onClearAll}>
            Clear all
          </button>
        ) : null}
      </div>

      {notifications.length === 0 ? (
        <EmptyState
          title="Nothing has happened yet."
          hint="Robot errors, deliveries and other real-time events appear here once the simulation is running."
        />
      ) : (
        <ul className="notification-list" aria-live="polite" aria-relevant="additions">
          {notifications.map((notification) => {
            const level = notification.level || 'info';
            return (
              <li key={notification.id} className={`notification-row notification-row--${level}`}>
                <span className={`notification-row__dot notification-row__dot--${level}`} aria-hidden="true" />
                <span className="notification-row__message">
                  <span className="sr-only">{LEVEL_DESCRIPTION[level] || level}: </span>
                  {notification.message}
                  {notification.timestamp ? (
                    <span className="log-row__meta"> · {formatTime(notification.timestamp)}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="notification-row__dismiss"
                  onClick={() => onDismiss?.(notification.id)}
                  aria-label={`Dismiss: ${notification.message}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default memo(NotificationsFeed);
