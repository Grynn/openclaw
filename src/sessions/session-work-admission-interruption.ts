import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { settlesWithin } from "../shared/settle-within.js";

/** Only the live run owner can confirm that this interruption accepted a stop. */
type SessionWorkAdmissionInterruptionReceipt = { runId: string };
export type SessionWorkAdmissionInterrupt = (
  reason?: Error,
) => SessionWorkAdmissionInterruptionReceipt | void;

/** An ordinary session interruption must not create a gateway-restart recovery claim. */
export function isSessionWorkRestartInterruptReason(reason: unknown): boolean {
  return isAgentRunRestartAbortReason(reason) || reason instanceof GatewayDrainingError;
}

export function resolveInterruptAbortReason(reason: Error | undefined): Error | undefined {
  return isSessionWorkRestartInterruptReason(reason) ? createAgentRunRestartAbortError() : reason;
}

export async function waitForSessionWorkAdmissionRelease(
  released: Promise<void>,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs === undefined) {
    await released;
    return true;
  }
  return await settlesWithin(released, Math.max(0, timeoutMs));
}
