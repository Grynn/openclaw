// Public provider-catalog runtime seams for provider plugin contract tests.

export {
  augmentModelCatalogWithProviderPlugins,
  classifyProviderFailoverSignalWithPlugin,
} from "../plugins/provider-runtime.js";
export {
  resolveCatalogHookProviderPluginIds,
  resolveOwningPluginIdsForProvider,
} from "../plugins/providers.js";
export {
  isPluginProvidersLoadInFlight,
  resolvePluginProvidersCore,
} from "../plugins/providers.runtime.js";
