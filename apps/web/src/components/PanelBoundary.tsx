"use client";

import { Component, type ReactNode } from "react";

/**
 * Keeps one panel's crash inside that panel.
 *
 * Next's route-level error.tsx catches a render error, but it replaces the
 * whole page: a null dereference in one tool panel took the map, the layers and
 * every other panel with it. Since panels render live third-party data whose
 * shape can change without notice — a feed that starts sending null where a
 * number was is the usual cause — the blast radius should be the panel.
 *
 * The error is shown rather than swallowed, because a panel that silently
 * renders nothing is indistinguishable from a panel with no results.
 */
interface Props {
  children: ReactNode;
  /** Shown in the message, so it is clear which panel failed. */
  name: string;
}

interface State {
  error: Error | null;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // The console is where a stack is actually readable; the panel shows the
    // message so the operator knows what broke without opening devtools.
    console.error(`[${this.props.name}]`, error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="panel-crash">
        <p className="panel-crash-head">{this.props.name} stopped</p>
        <p className="panel-crash-detail">{error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    );
  }
}
