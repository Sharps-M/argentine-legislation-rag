export type HealthReport = {
  status: "ok" | "degraded";
  database: "up" | "down";
  /** Installed pgvector version, or `null` when the extension is missing. */
  pgvector: string | null;
};

/** Minimal query interface, so the check can be tested without a database. */
export type HealthProbe = {
  ping: () => Promise<void>;
  vectorVersion: () => Promise<string | null>;
};

export async function checkHealth(probe: HealthProbe): Promise<HealthReport> {
  try {
    await probe.ping();
  } catch {
    return { status: "degraded", database: "down", pgvector: null };
  }

  let pgvector: string | null = null;
  try {
    pgvector = await probe.vectorVersion();
  } catch {
    pgvector = null;
  }

  return {
    status: pgvector ? "ok" : "degraded",
    database: "up",
    pgvector,
  };
}
