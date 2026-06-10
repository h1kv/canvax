import { readFileSync } from "node:fs";
import path from "node:path";
import type { NodeV2Type } from "../../../shared/types.js";

const SKILLS_DIR = path.join(process.cwd(), "skills");

export function loadSkill(type: NodeV2Type): string {
  const filePath = path.join(SKILLS_DIR, `${type}.md`);
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    throw new Error(`No skill file found for node type "${type}" at ${filePath}`);
  }
}
