export function isUrl(text: string): boolean {
  try { return ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function resolveContent(raw: string): Promise<string> {
  const url = raw.trim();
  if (!isUrl(url)) return raw;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "DISPATCH.AI/1.0 (context fetcher)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `[Failed to fetch ${url}: HTTP ${res.status}]`;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const body = ct.includes("html") ? stripHtml(text) : text;
    return `[Fetched: ${url}]\n${body.slice(0, 24_000)}`;
  } catch (err) {
    return `[Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

// Splits newline-separated entries (URLs or plain text) and resolves each independently.
export async function resolveMultiContent(raw: string): Promise<string> {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return resolveContent(raw.trim());
  const parts = await Promise.all(lines.map(resolveContent));
  return parts.join("\n\n---\n\n");
}
