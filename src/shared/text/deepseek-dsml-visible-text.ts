import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { createQuotedStringScanner } from "./quoted-string-scanner.js";

const DEEPSEEK_DSML_TOOL_KINDS = [
  "tool_use_error",
  "tool_calls",
  "tool_call",
  "function_calls",
] as const;
// Mirrors packages/ai/src/transports/deepseek-dsml-grammar.ts: the shipped
// single-bar forms plus the doubled full-width form observed in provider
// output. Kept local because this sanitizer runs on every delivery surface and
// must not pull the AI transport barrel in behind it.
const DEEPSEEK_DSML_MARKERS = ["|", "｜", "｜｜"].map((bar) => `${bar}DSML${bar}`);
const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `<${marker}${kind}>`),
);
const DEEPSEEK_DSML_TOOL_CLOSE_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  DEEPSEEK_DSML_TOOL_KINDS.map((kind) => `</${marker}${kind}>`),
);
const DEEPSEEK_DSML_TOOL_TOKENS = [
  ...DEEPSEEK_DSML_TOOL_OPEN_TOKENS,
  ...DEEPSEEK_DSML_TOOL_CLOSE_TOKENS,
];
const DEEPSEEK_DSML_TOOL_QUICK_RE = /<(?:\||｜{1,2})DSML/i;

function findEarliestDeepSeekDsmlToken(text: string, tokens: readonly string[], fromIndex: number) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token, fromIndex);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function findDeepSeekDsmlToolBlockEnd(
  text: string,
  openToken: string,
  start: number,
): number | null {
  const expectedCloses = [`</${openToken.slice(1)}`];
  const isInsideQuote = createQuotedStringScanner(text, start);
  let searchFrom = start;

  while (searchFrom < text.length) {
    const next = findEarliestDeepSeekDsmlToken(text, DEEPSEEK_DSML_TOOL_TOKENS, searchFrom);
    if (!next) {
      return null;
    }
    searchFrom = next.index + next.token.length;
    if (isInsideQuote(next.index)) {
      continue;
    }
    if (next.token.startsWith("</")) {
      if (next.token !== expectedCloses.at(-1)) {
        return null;
      }
      expectedCloses.pop();
      if (expectedCloses.length === 0) {
        return searchFrom;
      }
    } else {
      expectedCloses.push(`</${next.token.slice(1)}`);
    }
  }
  return null;
}

/**
 * Final delivery-boundary safeguard for provider-emitted DeepSeek DSML tool
 * blocks. Provider transports should recover/filter these earlier, but a
 * downgraded recovery answer must never expose the tool payload to a chat.
 */
export function stripDeepSeekDsmlToolCallBlocks(text: string): string {
  if (!text || !DEEPSEEK_DSML_TOOL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let output = "";
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const open = findEarliestDeepSeekDsmlToken(text, DEEPSEEK_DSML_TOOL_OPEN_TOKENS, searchFrom);
    if (!open) {
      break;
    }
    if (isInsideCode(open.index, codeRegions)) {
      searchFrom = open.index + open.token.length;
      continue;
    }

    output += text.slice(cursor, open.index);
    const end = findDeepSeekDsmlToolBlockEnd(text, open.token, open.index + open.token.length);
    if (end === null) {
      return output;
    }
    cursor = end;
    searchFrom = cursor;
  }

  if (cursor === 0) {
    return text;
  }
  return output + text.slice(cursor);
}
