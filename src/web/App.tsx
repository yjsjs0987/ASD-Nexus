import React, { useEffect, useState } from "react";
import { fetchProjects } from "./api/client.ts";
import type { KnownProjectSummary } from "agent-swarm-director";

declare global {
  interface Window {
    asdDesktop?: {
      pickDirectory: () => Promise<string | null>;
    };
  }
}

export function App(): React.ReactElement {
  const [projects, setProjects] = useState<KnownProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then((res) => setProjects(res.projects))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      );
  }, []);

  return (
    <div
      data-testid="asd-gui-app"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #1e293b",
          paddingBottom: "16px",
          marginBottom: "24px",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
          ASD GUI Workspace
        </h1>
        <span style={{ fontSize: "13px", color: "#94a3b8" }}>
          Known Projects: {projects.length}
        </span>
      </header>
      <main>
        {error ? (
          <div style={{ color: "#f87171" }} role="alert">
            {error}
          </div>
        ) : (
          <p style={{ color: "#cbd5e1" }}>
            ASD Multi-Harness Session Management GUI Foundation (G0) Ready.
          </p>
        )}
      </main>
    </div>
  );
}
