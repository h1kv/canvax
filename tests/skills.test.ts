import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

test("skills contain no merge conflict markers", async () => {
  const skillsDir = path.join(process.cwd(), "skills");
  const files = (await readdir(skillsDir)).filter((file) => file.endsWith(".md"));

  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(path.join(skillsDir, file), "utf-8");
    assert.doesNotMatch(content, /<<<<<<<|=======|>>>>>>>/, `${file} contains conflict markers`);
  }
});
