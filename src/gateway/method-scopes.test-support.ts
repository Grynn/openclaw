import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

export const pluginHandler: GatewayRequestHandler = ({ respond }) => respond(true, {});

export function setPluginGatewayMethodScope(
  method: string,
  scope: "operator.read" | "operator.write" | "operator.admin",
) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers[method] = pluginHandler;
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "test",
      name: method,
      handler: pluginHandler,
      scope,
    }),
  );
  setActivePluginRegistry(registry);
}
