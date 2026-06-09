import type { WebSocket } from "ws";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { send } from "../../state/store.js";
import { debug } from "../../utils/debug.js";

const SKILLS_DIR = join(process.cwd(), "skills");

interface Skill {
  role: string;
  content: string;
}

export async function handleSkillList(ws: WebSocket): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await readdir(SKILLS_DIR);
    } catch {
      // Directory doesn't exist yet
      send(ws, { type: "skill:list:response", skills: [] });
      return;
    }

    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    const skills: Skill[] = await Promise.all(
      mdFiles.map(async (filename) => {
        const role = filename.replace(/\.md$/, "");
        const content = await readFile(join(SKILLS_DIR, filename), "utf-8");
        return { role, content };
      })
    );

    // Sort by role name for stable ordering
    skills.sort((a, b) => a.role.localeCompare(b.role));

    send(ws, { type: "skill:list:response", skills });
  } catch (err) {
    debug("skill:list error", { err });
    send(ws, { type: "skill:list:response", skills: [] });
  }
}

export async function handleSkillUpdate(
  ws: WebSocket,
  data: Record<string, unknown>
): Promise<void> {
  const role = typeof data.role === "string" ? data.role.trim() : null;
  const content = typeof data.content === "string" ? data.content : null;

  if (!role || content === null) {
    send(ws, { type: "skill:update:error", message: "Missing role or content" });
    return;
  }

  // Sanitize role name — only allow alphanumeric, hyphens, underscores
  if (!/^[\w-]+$/.test(role)) {
    send(ws, { type: "skill:update:error", message: "Invalid role name" });
    return;
  }

  try {
    const filePath = join(SKILLS_DIR, `${role}.md`);
    await writeFile(filePath, content, "utf-8");
    send(ws, { type: "skill:update:response", role });
  } catch (err) {
    debug("skill:update error", { err });
    send(ws, { type: "skill:update:error", message: "Failed to write skill file" });
  }
}
