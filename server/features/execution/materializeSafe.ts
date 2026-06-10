import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MaterializeFilePlan, MaterializeWritePlan } from "../../../shared/types.js";

const MAX_FILE_BYTES = 1_048_576; // 1 MB

const DANGEROUS_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.ssh\//,
  /^\.git\//,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /private[_\-]?key/i,
  /id_rsa$/,
  /id_ed25519$/,
  /authorized_keys$/,
];

const SECRET_REGEXES = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|password|passwd|token)\s*[=:]\s*["']?\S{16,}/i,
  /sk-[a-zA-Z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
];

function parseFileMap(input: string): Map<string, string> {
  const files = new Map<string, string>();
  const parts = input.split(/^---\s*FILE:\s*.+?\s*---\s*$/m);
  const headers = [...input.matchAll(/^---\s*FILE:\s*(.+?)\s*---\s*$/gm)];
  for (let i = 0; i < headers.length; i++) {
    const filePath = headers[i][1].trim();
    const content = (parts[i + 1] ?? "").trimStart();
    if (filePath) files.set(filePath, content);
  }
  return files;
}

function startsWithPassVerdict(input: string): boolean {
  return /^\s*(?:\*\*)?VERDICT:\s*PASS(?:\*\*)?/i.test(input);
}

function isDangerous(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return DANGEROUS_PATTERNS.some((p) => p.test(norm));
}

function detectSecrets(content: string): string[] {
  return SECRET_REGEXES.filter((re) => re.test(content)).map(
    (re) => `Possible secret detected matching ${re.source.slice(0, 40)}…`
  );
}

function simpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const limit = 30;
  const out: string[] = [];
  const total = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < Math.min(total, limit); i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      out.push(`  ${o ?? ""}`);
    } else {
      if (o !== undefined) out.push(`- ${o}`);
      if (n !== undefined) out.push(`+ ${n}`);
    }
  }

  if (total > limit) out.push(`  … ${total - limit} more lines`);
  return out.join("\n");
}

export function buildWritePlan(input: string, workspacePath: string): MaterializeWritePlan {
  const parsed = parseFileMap(input);
  const plan: MaterializeWritePlan = {
    workspacePath,
    files: [],
    warnings: [],
    errors: [],
    requiresApproval: false,
  };

  if (parsed.size === 0) {
    const preview = input.slice(0, 300);
    plan.errors.push(startsWithPassVerdict(input)
      ? `Materialize received an Evaluate PASS verdict without any file delimiters. Evaluate must pass through the complete Create file map after PASS. Preview: ${preview}`
      : `No file delimiters found in Materialize input. Preview: ${preview}`);
    return plan;
  }

  const resolvedWorkspace = path.resolve(workspacePath);

  for (const [relPath, content] of parsed) {
    const filePlan: MaterializeFilePlan = {
      relativePath: relPath,
      absolutePath: "",
      action: "create",
      exists: false,
      bytes: Buffer.byteLength(content, "utf-8"),
      warnings: [],
    };

    // Reject absolute paths
    if (path.isAbsolute(relPath)) {
      plan.errors.push(`Rejected absolute path: ${relPath}`);
      continue;
    }

    // Reject home-relative paths
    if (relPath.startsWith("~/") || relPath === "~") {
      plan.errors.push(`Rejected home-relative path: ${relPath}`);
      continue;
    }

    const absPath = path.resolve(resolvedWorkspace, relPath);
    filePlan.absolutePath = absPath;

    // Reject path traversal
    if (!absPath.startsWith(resolvedWorkspace + path.sep) && absPath !== resolvedWorkspace) {
      plan.errors.push(`Rejected path traversal: ${relPath} → ${absPath}`);
      continue;
    }

    // Reject dangerous files
    if (isDangerous(relPath)) {
      plan.errors.push(`Rejected dangerous file: ${relPath}`);
      continue;
    }

    // Size limit
    if (filePlan.bytes > MAX_FILE_BYTES) {
      plan.errors.push(
        `File too large: ${relPath} (${filePlan.bytes} bytes, max ${MAX_FILE_BYTES})`
      );
      continue;
    }

    // Secret detection
    const secrets = detectSecrets(content);
    if (secrets.length > 0) {
      filePlan.warnings.push(...secrets);
      plan.warnings.push(`${relPath}: ${secrets.join("; ")}`);
    }

    // Determine action + diff
    filePlan.exists = existsSync(absPath);
    if (filePlan.exists) {
      const existing = readFileSync(absPath, "utf-8");
      if (existing === content) {
        filePlan.action = "skip";
      } else {
        filePlan.action = "modify";
        filePlan.diff = simpleDiff(existing, content);
        plan.requiresApproval = true;
      }
    }

    plan.files.push(filePlan);
  }

  return plan;
}

// Full pipeline — build plan, validate, emit plan event, then execute atomically.
export function safelyMaterialize(
  input: string,
  workspacePath: string,
  onLog: (level: "info" | "warn" | "done", msg: string) => void,
  onPlan: (plan: MaterializeWritePlan) => void
): string {
  const plan = buildWritePlan(input, workspacePath);
  onPlan(plan);

  if (plan.errors.length > 0) {
    throw new Error(`Materialize blocked:\n${plan.errors.join("\n")}`);
  }

  onLog("info", `Materialize: parsed ${plan.files.length} file block(s)`);
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) onLog("warn", w);
  }

  // Execute using the parsed content (re-parse needed since executeWritePlan lost content)
  const parsed = parseFileMap(input);
  const resolvedWorkspace = path.resolve(workspacePath);
  let written = 0;
  let skipped = 0;

  for (const file of plan.files) {
    const content = parsed.get(file.relativePath) ?? "";

    if (file.action === "skip") {
      onLog("info", `Materialize: skip ${file.relativePath} (unchanged)`);
      skipped++;
      continue;
    }

    for (const w of file.warnings) {
      onLog("warn", `Materialize: ⚠ ${file.relativePath}: ${w}`);
    }

    onLog("info", `Materialize: ${file.action} ${file.relativePath}`);
    mkdirSync(path.dirname(path.resolve(resolvedWorkspace, file.relativePath)), { recursive: true });

    const absPath = file.absolutePath;
    const tmpPath = `${absPath}.dispatch-tmp`;
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, absPath);
    written++;
    onLog("done", `Materialize: wrote ${file.relativePath} (${file.bytes} bytes)`);
  }

  return `Materialized ${written} file(s)${skipped > 0 ? `, skipped ${skipped}` : ""}.`;
}
