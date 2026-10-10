import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { DiscoveredLocalServer, ThreadId } from "@t3tools/contracts";

type Thread = Pick<EnvironmentThreadShell, "id" | "projectId" | "title" | "worktreePath">;
type Project = Pick<EnvironmentProject, "id" | "title" | "workspaceRoot">;

function normalizedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function containsPath(root: string, cwd: string): boolean {
  const path = normalizedPath(root);
  const directory = normalizedPath(cwd);
  return directory === path || directory.startsWith(`${path}/`);
}

/** Terminal ownership is authoritative. A shared working directory never identifies a thread. */
export function resolveServerOwner(
  server: DiscoveredLocalServer,
  threads: ReadonlyArray<Thread>,
  projects: ReadonlyArray<Project>,
): {
  threadId: ThreadId | null;
  threadTitle: string | null;
  projectName: string | null;
  inferred: boolean;
} {
  const terminalThreadId = server.terminal?.threadId;
  if (terminalThreadId !== undefined) {
    const thread = threads.find((entry) => entry.id === terminalThreadId);
    return {
      threadId: terminalThreadId,
      threadTitle: thread?.title ?? "Unknown thread",
      projectName: projects.find((entry) => entry.id === thread?.projectId)?.title ?? null,
      inferred: false,
    };
  }
  const cwd = server.managedProcess?.cwd ?? server.processDetails?.cwd;
  if (!cwd) return { threadId: null, threadTitle: null, projectName: null, inferred: false };
  const candidates = threads.filter(
    (thread) => thread.worktreePath && containsPath(thread.worktreePath, cwd),
  );
  const longest = Math.max(
    0,
    ...candidates.map((thread) => normalizedPath(thread.worktreePath!).length),
  );
  const matches = candidates.filter(
    (thread) => normalizedPath(thread.worktreePath!).length === longest,
  );
  const thread = matches.length === 1 ? matches[0] : undefined;
  const project = thread
    ? projects.find((entry) => entry.id === thread.projectId)
    : projects
        .filter((entry) => containsPath(entry.workspaceRoot, cwd))
        .toSorted((left, right) => right.workspaceRoot.length - left.workspaceRoot.length)[0];
  return {
    threadId: thread?.id ?? null,
    threadTitle: thread?.title ?? null,
    projectName: project?.title ?? null,
    inferred: thread !== undefined,
  };
}
