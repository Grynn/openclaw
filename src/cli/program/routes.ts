import { cliCommandCatalog } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import { routedCommandDefinitions } from "./routed-command-definitions.js";

/** Bind validated arguments before startup; defer command imports and execution until afterward. */
export function findRoutedCommand(
  path: string[],
  argv: string[],
  // A routed command may decline at execution time (for example a memory search that
  // finds no usable Gateway); `false` hands the invocation back to Commander.
): (() => Promise<void | boolean>) | null {
  for (const entry of cliCommandCatalog) {
    if (!entry.route || !matchesCommandPath(path, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    const definition = routedCommandDefinitions[entry.route.id];
    const args = definition.parseArgs(argv);
    if (args !== null) {
      return async () => await definition.runParsedArgs(args as never);
    }
  }
  return null;
}
