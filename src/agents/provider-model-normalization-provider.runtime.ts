// Stable lazy target for provider-owned model id normalization. Keep the
// provider runtime graph behind this one-export sidecar so light model parsing
// does not import it eagerly.
export { normalizeProviderModelIdWithPlugin } from "../plugins/provider-runtime.js";
