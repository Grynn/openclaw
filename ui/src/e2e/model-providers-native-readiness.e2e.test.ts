import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelCatalogEntry, ModelCatalogResult } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { setupContext, setupPages } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model Providers native credential readiness" });
const withPage = setupPages(suite, setupContext);

suite.define(() => {
  it("shows the usable native route without disguising direct credential failures", async () => {
    await withPage(
      async ({ page }) => {
        const nativeModel: ModelCatalogEntry = {
          id: "native-model",
          name: "Native model",
          provider: "anthropic",
          available: true,
          agentRuntime: { id: "claude-cli", source: "model" },
        };
        const catalog: ModelCatalogResult = {
          models: [nativeModel],
          providerOutcomes: [{ provider: "anthropic", status: "ready" }],
        };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          models: catalog.models,
          methodResponses: {
            "models.list": catalog,
            "models.authStatus": {
              ts: 1,
              providers: [
                {
                  provider: "anthropic",
                  displayName: "Anthropic",
                  status: "expired",
                  profiles: [],
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const provider = page.locator('[data-provider-id="anthropic"]');
        await provider.waitFor();
        const badge = provider.locator(".model-providers__head .settings-status");
        await expect.poll(() => badge.textContent()).not.toBe("Checking models…");
        if (process.env.OPENCLAW_UI_E2E_RECORD === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [provider],
            {
              elements: [provider],
              scrollTo: provider,
              animations: "disabled",
            },
          );
          await writeFile(
            path.join(suite.artifactDir, "native-credential-readiness.png"),
            frame.png,
          );
          await writeFile(path.join(suite.artifactDir, "provider.png"), frame.elements[0]!.png);
        }
        expect(await badge.textContent()).toBe("Ready");
        expect(await provider.locator(".model-providers__credentials").textContent()).toContain(
          "Managed by Claude CLI · native",
        );
        expect(await provider.getByRole("button", { name: "Test connection" }).count()).toBe(0);

        await gateway.setMethodResponse("models.list", {
          models: [{ ...nativeModel, available: false, unavailableReason: "missing-auth" }],
          providerOutcomes: [{ provider: "anthropic", status: "auth-rejected" }],
        });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect.poll(() => badge.textContent()).toBe("Expired");
        expect(await provider.locator(".model-providers__credentials").textContent()).not.toContain(
          "Managed by Claude CLI · native",
        );
        expect(await gateway.getRequests("models.probe")).toHaveLength(0);
      },
      { viewport: { width: 1440, height: 1100 } },
    );
  });
});
