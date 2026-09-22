/**
 * OpenAI-compatible HTTP gateway startup helper for tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestPortClaim } from "../test-utils/port-claims.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/** Starts a local gateway with only the OpenAI-compatible HTTP surface configured. */
export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: StartGatewayServer;
  port: TestPortClaim;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  return await startClaimedGateway(options.port, () =>
    options.startGatewayServer(options.port.port, {
      host: "127.0.0.1",
      auth: options.auth,
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
    }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function startGenericEmbeddingServer(
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    body: Record<string, unknown>;
  }>,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readJsonBody(req);
      requests.push({
        method: req.method,
        url: req.url,
        body,
      });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const inputType = body.input_type;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: input.map((_text, index) => ({
            object: "embedding",
            embedding: [index + 9.1, inputType === "document" ? 9.2 : 0],
            index,
          })),
          model: body.model,
        }),
      );
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
