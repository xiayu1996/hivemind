import { readFile } from "node:fs/promises";
const path = process.argv[2]!;
const text = await readFile(path, "utf8");
const lines = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
for (const entry of lines.reverse()) {
  const message = (entry.message ?? entry) as Record<string, unknown>;
  const role = String(message.role ?? "");
  if (role !== "assistant") continue;
  const content = message.content;
  const textOut = Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
    : String(content ?? "");
  if (!textOut.trim()) continue;
  console.log("assistant text length:", textOut.length);
  console.log("first 500:", textOut.slice(0, 500));
  console.log("last 500:", textOut.slice(-500));
  break;
}
process.exit(0);
