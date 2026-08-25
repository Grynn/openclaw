export class PreparedModelCatalogConfigReplacedError extends Error {
  constructor(agentDir: string) {
    super(`prepared model catalog owner config was replaced during the read (${agentDir})`);
    this.name = "PreparedModelCatalogConfigReplacedError";
  }
}

export function isPreparedModelCatalogConfigReplacedError(
  error: unknown,
): error is PreparedModelCatalogConfigReplacedError {
  return (
    error instanceof PreparedModelCatalogConfigReplacedError ||
    (error instanceof Error && error.name === "PreparedModelCatalogConfigReplacedError")
  );
}
