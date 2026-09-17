// The sealed worker's prewarm run produces no side effect a parent can observe,
// so this single stdout line is its only success signal. Keep the shape versioned:
// installers and the immutable-release gate parse it to prove the sealed bootstrap
// still forces fs-safe native mode off instead of loading host-native code.
export const WORKER_PREWARM_ACKNOWLEDGEMENT_SCHEMA = 1;

export function formatWorkerPrewarmAcknowledgement(fsSafeNativeMode: string): string {
  return `${JSON.stringify({
    fsSafeNativeMode,
    protocol: WORKER_PREWARM_ACKNOWLEDGEMENT_SCHEMA,
  })}\n`;
}
