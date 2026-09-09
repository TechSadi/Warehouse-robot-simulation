import { Component } from 'react';
import { reportError } from '../../api/telemetry.js';
import './ErrorBoundary.css';

/**
 * Stops one broken panel from taking the whole dashboard with it.
 *
 * Without a boundary, a render error anywhere below the root unmounts the
 * entire tree and leaves a blank page - no navigation, no sign-out, no
 * indication that anything happened. That is a plausible failure here:
 * panels render server data (robot positions, order documents, path traces)
 * whose shape this client does not control, and a single unexpected null
 * from a partially-applied update would do it.
 *
 * It now also reports. This used to say, honestly, that there was no
 * telemetry backend and inventing one would be scope nobody asked for -
 * which was right that a vendor SDK does not belong here, and wrong that
 * the alternative was the console. A render error in a deployed build that
 * only reaches `console.error` is invisible unless a user thinks to
 * mention it. The report goes to this project's own API and becomes a log
 * line the user can already read in the Logs panel; nothing leaves the
 * deployment. See api/telemetry.js for why it can never throw, retry, or
 * fire more than once for the same failure.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console line stays: it is what a developer with the tab open
    // actually reads, and it works when the report does not.
    console.error(`[${this.props.label || 'app'}] render failed:`, error, info?.componentStack);
    reportError(error, {
      boundary: this.props.label || 'app',
      componentStack: info?.componentStack,
    });
  }

  handleReset() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="error-boundary" role="alert">
        <p className="error-boundary__title">{this.props.label || 'This panel'} stopped working.</p>
        <p className="error-boundary__detail">
          The rest of the dashboard is still running. Try again, or reload the page if it keeps happening.
        </p>
        <button type="button" className="panel__button" onClick={this.handleReset}>
          Try again
        </button>
      </div>
    );
  }
}
