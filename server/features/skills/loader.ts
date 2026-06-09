import { readFileSync } from "fs";
import { join } from "path";
import { NODE_SKILLS } from "./index.js";

const SKILLS_DIR = join(process.cwd(), "skills");

function loadSkillFile(filename: string): string | null {
  try {
    return readFileSync(join(SKILLS_DIR, filename), "utf-8");
  } catch {
    return null;
  }
}

const baseSkill = loadSkillFile("_base.md") ?? "";
const skillCache: Map<string, string> = new Map();

export function getSkillPrompt(role: string): string {
  if (skillCache.has(role)) return skillCache.get(role)!;

  const roleSkill = loadSkillFile(`${role}.md`);
  if (!roleSkill) {
    return NODE_SKILLS[role] ?? "";
  }

  const combined = `${baseSkill}\n\n---\n\n${roleSkill}`;
  skillCache.set(role, combined);
  return combined;
}
