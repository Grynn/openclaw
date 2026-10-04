export function createQuotedStringScanner(text: string, start: number): (end: number) => boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;
  // Candidate closing tags share one monotonic scan through their payload.
  let cursor = start;
  return (end) => {
    for (; cursor < end; cursor += 1) {
      const char = text[cursor];
      if (quoteChar === null) {
        if (char === '"' || char === "'") {
          quoteChar = char;
        }
      } else if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === quoteChar) {
        quoteChar = null;
      }
    }
    return quoteChar !== null;
  };
}
