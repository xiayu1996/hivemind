/** Extracts the last assistant text without trusting provider-specific wrapper fields. */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (const value of messages.toReversed()) {
    if (typeof value !== "object" || value === null) continue;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.length > 0) return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((item): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string")
      .map((item) => item.text)
      .join("");
    if (text.length > 0) return text;
  }
  throw new Error("runner produced no assistant text");
}
