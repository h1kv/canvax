import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const BRANCH = "rapid-deployments";

interface VercelDeployment {
  uid: string;
  url: string;
  state: "BUILDING" | "ERROR" | "INITIALIZING" | "QUEUED" | "READY" | "CANCELED";
  createdAt: number;
  meta?: { githubCommitRef?: string; gitlabCommitRef?: string };
}

export async function deployToVercel(
  workspacePath: string,
  signal: AbortSignal
): Promise<string> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;

  const pushTime = Date.now();
  const commitMsg = `rapid: ${new Date().toISOString()}`;

  // Stage workspace files into the index (doesn't touch working branch)
  try {
    await execFile("git", ["add", workspacePath]);
  } catch {
    // nothing to stage — continue with current index
  }

  // Write the full index to a tree object
  const { stdout: treeOut } = await execFile("git", ["write-tree"]);
  const treeHash = treeOut.trim();

  // Parent = remote rapid-deployments if it exists, otherwise current HEAD
  let parentHash: string;
  try {
    const { stdout } = await execFile("git", ["rev-parse", `origin/${BRANCH}`]);
    parentHash = stdout.trim();
  } catch {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"]);
    parentHash = stdout.trim();
  }

  // Create commit object without updating any branch ref
  const { stdout: commitOut } = await execFile("git", [
    "commit-tree", treeHash, "-p", parentHash, "-m", commitMsg,
  ]);
  const commitHash = commitOut.trim();

  // Push that commit to remote rapid-deployments (no local branch change)
  await execFile("git", ["push", "-f", "origin", `${commitHash}:refs/heads/${BRANCH}`]);

  // Restore index so current branch is unaffected
  try {
    await execFile("git", ["reset", "HEAD", "--", workspacePath]);
  } catch {
    // ignore
  }

  if (!token || !projectId) {
    return `Pushed to ${BRANCH}.\n\n(Set VERCEL_TOKEN + VERCEL_PROJECT_ID in .env to get the deployment URL automatically.)`;
  }

  // Poll Vercel until the deployment is ready
  for (let attempt = 0; attempt < 40; attempt++) {
    if (signal.aborted) throw new Error("Aborted");
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    let data: { deployments: VercelDeployment[] };
    try {
      const res = await fetch(
        `https://api.vercel.com/v9/deployments?projectId=${encodeURIComponent(projectId)}&limit=10`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
      );
      if (!res.ok) continue;
      data = await res.json() as typeof data;
    } catch {
      continue;
    }

    const deployment = data.deployments.find(
      (d) =>
        d.createdAt > pushTime - 15000 &&
        (d.meta?.githubCommitRef === BRANCH || d.meta?.gitlabCommitRef === BRANCH)
    );

    if (!deployment) continue;

    const url = `https://${deployment.url}`;
    if (deployment.state === "READY") return `Deployed!\n\n${url}`;
    if (deployment.state === "ERROR" || deployment.state === "CANCELED") {
      return `Deployment ${deployment.state.toLowerCase()}.\n\nCheck Vercel dashboard: ${url}`;
    }
    // BUILDING / INITIALIZING / QUEUED — keep polling
  }

  return `Pushed to ${BRANCH}. Deployment is taking longer than expected — check your Vercel dashboard.`;
}
