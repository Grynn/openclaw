import type { AuthProfileFailureReason } from "./types.js";

/** Details needed by auth-state consumers to avoid unnecessary repair work. */
type AuthProfileFailureEvent = {
  reason: AuthProfileFailureReason;
  source: "profile" | "inline-provider-api-key";
};

/** Hook invoked when auth profile failure state changes. */
type AuthProfileFailureHook = (event?: AuthProfileFailureEvent) => void;

let authProfileFailureHook: AuthProfileFailureHook | undefined;

/** Installs or clears the process-local auth profile failure hook. */
export function setAuthProfileFailureHook(hook: AuthProfileFailureHook | undefined): void {
  authProfileFailureHook = hook;
}

/** Notifies the process-local auth profile failure hook. */
export function notifyAuthProfileFailureHook(event?: AuthProfileFailureEvent): void {
  authProfileFailureHook?.(event);
}
