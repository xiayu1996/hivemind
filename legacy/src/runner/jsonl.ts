/**
 * Framing for pi's RPC mode.
 *
 * The protocol is strict JSONL with LF as the only record delimiter. A trailing
 * CR is stripped so Windows-side output parses, but nothing else may split a
 * record. Node's `readline` is not usable here: it also splits on U+2028 and
 * U+2029, which are legal inside JSON strings, so a model reply containing one
 * would silently tear a record in half.
 */
export class JsonlDecoder {
  #buffer = "";

  /** Feeds a stdout chunk and returns the records completed by it. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];

    let index: number;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length > 0) lines.push(line);
    }

    return lines;
  }

  /** Bytes held back because no delimiter has arrived yet. */
  get pending(): string {
    return this.#buffer;
  }

  reset(): void {
    this.#buffer = "";
  }
}

export function encodeCommand(command: unknown): string {
  return `${JSON.stringify(command)}\n`;
}
