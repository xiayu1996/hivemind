/**
 * Notion's canonical page URL is the page identifier without hyphens. The
 * central database stores the identifier, so the URL is derived on every read
 * and never cached here: a page moved in Notion leaves no stale link behind.
 */
export function notionPageUrl(pageId: string | null | undefined): string {
  const compact = (pageId ?? "").replaceAll("-", "").trim();
  if (compact === "") throw new Error("notion page id is required");
  return `https://www.notion.so/${compact}`;
}
