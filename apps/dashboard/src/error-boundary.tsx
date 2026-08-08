import { Component, type ReactNode } from 'react';

export class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    // The dashboard never renders stack traces or error details into the local UI.
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="route-error" role="alert">
          <p className="eyebrow">Pulse route</p>
          <h1>Dashboard rendering unavailable</h1>
          <p>Reload the local page to request a fresh, validated snapshot.</p>
        </main>
      );
    }
    return this.props.children;
  }
}
