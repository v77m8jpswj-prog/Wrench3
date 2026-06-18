import React from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

/**
 * ErrorBoundary — catches any render error in the subtree and shows a recoverable
 * panel instead of blanking out the whole app to black. Without this, ONE bad
 * regex or render in ANY page kills the entire SPA. Wrap every route in it.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught:", error, errorInfo);
    this.setState({ errorInfo });
    // Best-effort report to backend so we know it happened
    try {
      const token = localStorage.getItem("dw_token");
      const body = JSON.stringify({
        page: this.props.label || window.location.pathname,
        message: String(error?.message || error),
        stack: String(error?.stack || "").slice(0, 2000),
        component_stack: String(errorInfo?.componentStack || "").slice(0, 2000),
        user_agent: navigator.userAgent.slice(0, 200),
        url: window.location.href,
      });
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* never break the error UI */ }
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-bg-1 text-ink flex items-center justify-center p-6" data-testid="error-boundary">
        <div className="max-w-lg w-full panel p-6 border-l-4 border-rust">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="text-rust" size={20} />
            <h2 className="heading text-xl">WRENCH HIT A SNAG</h2>
          </div>
          <p className="text-ink-2 text-sm mb-3">
            Something in <span className="text-amber2 font-bold">{this.props.label || "this page"}</span> blew up while rendering.
            The rest of the app is still good — use one of the buttons below to recover.
          </p>
          <pre className="text-xs text-ink-3 bg-bg-2 border border-line p-2 mb-4 max-h-32 overflow-auto whitespace-pre-wrap break-words" data-testid="error-boundary-message">
            {String(this.state.error?.message || this.state.error || "Unknown error")}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={this.reset}
              data-testid="error-retry-btn"
              className="btn-rust flex items-center gap-1 text-xs"
            >
              <RefreshCw size={12}/> TRY AGAIN
            </button>
            <button
              onClick={() => { window.location.href = "/"; }}
              data-testid="error-home-btn"
              className="border-2 border-amber2 text-amber2 px-3 py-2 flex items-center gap-1 text-xs uppercase tracking-widest hover:bg-amber2/10"
            >
              <Home size={12}/> HOME
            </button>
            <button
              onClick={() => window.location.reload()}
              data-testid="error-reload-btn"
              className="border-2 border-line text-ink-2 px-3 py-2 text-xs uppercase tracking-widest hover:bg-bg-3"
            >
              FULL RELOAD
            </button>
          </div>
        </div>
      </div>
    );
  }
}
