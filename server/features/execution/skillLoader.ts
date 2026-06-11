import { readFileSync } from "node:fs";
import path from "node:path";
import type { LoadedSkill, NodeV2Type, SkillMeta } from "../../../shared/types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw: string): { meta: SkillMeta; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };

  const yamlBlock = match[1];
  const body = raw.slice(match[0].length).trim();
  const meta: SkillMeta = {};

  for (const line of yamlBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");

    if (key === "model") meta.model = value;
    else if (key === "temperature") meta.temperature = parseFloat(value);
    else if (key === "max_tokens") meta.maxTokens = parseInt(value, 10);
    else if (key === "description") meta.description = value;
    else if (key === "tools") {
      const inner = value.replace(/^\[|\]$/g, "").trim();
      meta.tools = inner ? inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")) : [];
    }
  }

  return { meta, body };
}

export function loadSkill(type: NodeV2Type | string): LoadedSkill {
  const filePath = path.join(SKILLS_DIR, `${type}.md`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`No skill file found for node type "${type}" at ${filePath}`);
  }
  const { meta, body } = parseFrontmatter(raw);
  return { systemPrompt: body, meta };
}

export function loadAllSkillMeta(types: readonly string[]): Record<string, SkillMeta> {
  const result: Record<string, SkillMeta> = {};
  for (const type of types) {
    try {
      result[type] = loadSkill(type).meta;
    } catch { /* skip missing */ }
  }
  return result;
}
