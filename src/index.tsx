import React, { ErrorInfo } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

interface AppBoundaryState {
  error: Error | null;
}

class AppBoundary extends React.Component<
  React.PropsWithChildren,
  AppBoundaryState
> {
  state: AppBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Silo renderer failed to start", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 32,
            background: "#0b0b0c",
            color: "#f4f1ed",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          <section
            style={{
              maxWidth: 520,
              padding: 28,
              border: "1px solid #2c2c30",
              borderRadius: 12,
              background: "#131315",
            }}
          >
            <h1 style={{ margin: "0 0 10px", color: "#ff9a4a", fontSize: 22 }}>
              Silo could not start
            </h1>
            <p
              style={{ margin: "0 0 18px", color: "#c8c3bc", lineHeight: 1.5 }}
            >
              The interface hit an error while loading. Reload Silo to try
              again.
            </p>
            <pre
              style={{
                maxHeight: 180,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                color: "#9a9690",
                fontSize: 12,
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 12,
                padding: "9px 14px",
                border: 0,
                borderRadius: 6,
                background: "#ff7a1a",
                color: "#111",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Reload Silo
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

root.render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>,
);
