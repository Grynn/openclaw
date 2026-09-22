// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, beforeEach, vi } from "vitest";
import { cleanupExtensionTestHome } from "./extension-database-test-lifecycle.js";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

beforeEach(() => {
  vi.useRealTimers();
});

afterAll(() => cleanupExtensionTestHome(testEnv.cleanup));
