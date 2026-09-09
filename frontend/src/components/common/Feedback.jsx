import './Feedback.css';

/**
 * The four things a panel says when it has nothing to show: it is loading,
 * it failed, it is empty, or something needs the user's attention.
 *
 * Every panel used to spell these out itself with a bare
 * `<p className="panel__empty-hint">`, which meant an empty list, a loading
 * state and a hard error were visually identical, none of them told a
 * screen reader anything had changed, and only some of them suggested what
 * to do next. Sharing the components is what makes "loading" look like
 * loading everywhere, and makes every error carry an action.
 */

/**
 * A live region for asynchronous status. `polite` announces without
 * interrupting; errors use `assertive` because they usually mean the thing
 * the user just asked for did not happen.
 */
export function StatusMessage({ tone = 'info', assertive = false, children, className = '' }) {
  return (
    <p
      className={`feedback feedback--${tone} ${className}`.trim()}
      role="status"
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      {children}
    </p>
  );
}

/** Progress for an in-flight load. The spinner is decorative - the text is
 * what carries the meaning, for sighted and screen-reader users alike. */
export function LoadingState({ label = 'Loading…' }) {
  return (
    <p className="feedback feedback--loading" role="status" aria-live="polite">
      <span className="feedback__spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * An empty list, distinguished from a failed one.
 *
 * `hint` is required by convention rather than by signature: an empty state
 * that does not say how to stop being empty is a dead end, and this app has
 * six of them (no robots, no orders, no warehouses, no simulation, no path,
 * no obstacles).
 */
export function EmptyState({ title, hint = null, action = null }) {
  return (
    <div className="feedback feedback--empty">
      <p className="feedback__title">{title}</p>
      {hint ? <p className="feedback__hint">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * A failure, with a way out of it. `onRetry` renders a retry button because
 * most failures here are transient (a dropped connection, a rate limit) and
 * the alternative is asking the user to reload the whole dashboard.
 */
export function ErrorState({ message, onRetry = null, retryLabel = 'Try again' }) {
  return (
    <div className="feedback feedback--error" role="alert">
      <p className="feedback__title">{message}</p>
      {onRetry ? (
        <button type="button" className="panel__button" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A dismissible banner for something that happened rather than something
 * that is. Used for action failures, which should not permanently replace a
 * panel's contents the way ErrorState does.
 */
export function Banner({ tone = 'error', children, onDismiss = null, dismissLabel = 'Dismiss' }) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="banner__text">{children}</span>
      {onDismiss ? (
        <button type="button" className="banner__dismiss" onClick={onDismiss} aria-label={dismissLabel}>
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
