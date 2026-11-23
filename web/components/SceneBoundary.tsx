"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  children: ReactNode;
}

/** Shows the lightweight version when the WebGL scene throws (shader error, out of memory, driver bug). */
export class SceneBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("scene failed, using fallback", error.message, info.componentStack?.slice(0, 120));
  }

  render(): ReactNode {
    return this.state.failed ? <div className="flex h-full items-center justify-center px-4 pt-24">{this.props.fallback}</div> : this.props.children;
  }
}
