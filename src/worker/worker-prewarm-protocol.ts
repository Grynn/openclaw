export const WORKER_PREWARM_ACKNOWLEDGEMENT_SCHEMA = 1;

export function formatWorkerPrewarmAcknowledgement(fsSafeNativeMode: string): string {
  return `${JSON.stringify({
    fsSafeNativeMode,
    protocol: WORKER_PREWARM_ACKNOWLEDGEMENT_SCHEMA,
  })}\n`;
}
