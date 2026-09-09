import { Component } from 'react';
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
 * Deliberately not a place to report errors to a service - there is no
 * telemetry backend in this project, and inventing one here would be
 * scope no one asked for. It logs to the console and gets out of the way.
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
    console.error(`[${this.props.label || 'app'}] render failed:`, error, info?.componentStack);
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
