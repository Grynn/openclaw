/**
 * Fast generic tool stubs.
 *
 * Provides lightweight tool records and shared mocks for media/web/plugin tool imports.
 */
import { vi } from "vitest";
import type { AgentToolResult } from "../runtime/index.js";

type StubTool = {
  label: string;
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown> };
  // Keep the exported type portable: don't leak Vitest's mock types into .d.ts.
  execute: (...args: unknown[]) => Promise<AgentToolResult<unknown>>;
};

export const stubTool = (name: string): StubTool => ({
  label: `${name} stub`,
  name,
  description: `${name} stub`,
  parameters: { type: "object", properties: {} },
  execute: vi.fn(async () => ({ content: [], details: undefined })) as unknown as (
    ...args: unknown[]
  ) => Promise<AgentToolResult<unknown>>,
});

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => stubTool("view_image"),
}));

vi.mock("../tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => stubTool("image_generate"),
}));

vi.mock("../tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: () => stubTool("video_generate"),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebSearchTool: () => null,
  createWebFetchTool: () => null,
}));

vi.mock("../../plugins/tools.js", () => ({
  buildPluginToolMetadataKey: (pluginId: string, toolName: string) =>
    JSON.stringify([pluginId, toolName]),
  copyPluginToolMeta: (_from: unknown, to: unknown) => to,
  getPluginToolMeta: () => undefined,
  resolvePluginTools: () => [],
}));
