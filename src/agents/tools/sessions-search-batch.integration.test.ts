import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

it("searches several queries through the tool, Gateway and durable transcript reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:batch-search";
    const storePath = state.statePath("batch-search.sqlite");
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: storePath },
      tools: { sessions: { visibility: "self" } },
    };
    setRuntimeConfigSnapshot(config);
    for (const key of [sessionKey, "agent:main:excluded"]) {
      await replaceTranscriptEvents(
        { agentId: "main", sessionKey: key, sessionId: key, storePath, env: state.env },
        [
          { type: "session", id: key, version: 3 },
          {
            type: "message",
            id: "alpha-message",
            parentId: null,
            timestamp: 1,
            message: { role: "user", content: "Alpha deployment notes" },
          },
          {
            type: "message",
            id: "beta-message",
            parentId: "alpha-message",
            timestamp: 2,
            message: { role: "assistant", content: "Beta reliability notes" },
          },
        ],
      );
    }
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: storePath,
      env: state.env,
    });
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
    });
    const tool = createSessionsSearchTool({
      agentId: "main",
      agentSessionKey: sessionKey,
      sessionReadScopeKey: sessionKey,
      config,
    });
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        const scalar = await tool.execute("scalar-control", { query: "Alpha" });
        expect(scalar.details).toMatchObject({
          results: [{ sessionKey, messageId: "alpha-message" }],
        });
        const batch = await tool.execute("batch", { queries: ["Alpha", "Beta"] });
        expect(batch.details).toMatchObject({
          batch: true,
          queryCount: 2,
          results: [
            { queryIndex: 0, sessionKey, messageId: "alpha-message" },
            { queryIndex: 1, sessionKey, messageId: "beta-message" },
          ],
        });
        expect(JSON.stringify(batch.details)).not.toContain("excluded");
      },
    );
  });
});
