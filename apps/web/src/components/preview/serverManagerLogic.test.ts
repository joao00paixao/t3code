import { ProjectId, ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerOwner } from "./serverManagerLogic";

const projectId = ProjectId.make("project");
const projects = [{ id: projectId, title: "Example", workspaceRoot: "/projects/example" }];
const thread = (id: string, worktreePath: string | null) => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  worktreePath,
});
const listener = (cwd: string | null): DiscoveredLocalServer => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: "node",
  pid: 42,
  terminal: null,
  managedProcess: { startTimeMs: 1000, command: "node dev", cwd, canStop: true },
});

describe("server ownership", () => {
  it("prefers authoritative terminal ownership over a different working directory", () => {
    const server = {
      ...listener("/worktrees/other"),
      terminal: { threadId: ThreadId.make("terminal-owner"), terminalId: "term" },
    };
    expect(
      resolveServerOwner(
        server,
        [thread("terminal-owner", "/worktrees/owner"), thread("other", "/worktrees/other")],
        projects,
      ),
    ).toEqual({
      threadId: "terminal-owner",
      threadTitle: "terminal-owner",
      projectName: "Example",
      inferred: false,
    });
  });

  it("attributes a nested server directory to the most specific unique worktree", () => {
    expect(
      resolveServerOwner(
        listener("/worktrees/task/subtask/web"),
        [thread("parent", "/worktrees/task"), thread("child", "/worktrees/task/subtask")],
        projects,
      ),
    ).toMatchObject({ threadId: "child", inferred: true });
  });

  it("does not invent thread ownership for a shared worktree or primary checkout", () => {
    expect(
      resolveServerOwner(
        listener("/worktrees/shared/web"),
        [thread("one", "/worktrees/shared"), thread("two", "/worktrees/shared")],
        projects,
      ).threadId,
    ).toBeNull();
    expect(
      resolveServerOwner(
        listener("/projects/example/web"),
        [thread("one", null), thread("two", null)],
        projects,
      ),
    ).toEqual({ threadId: null, threadTitle: null, projectName: "Example", inferred: false });
  });

  it("respects directory boundaries and does not assign an external listener", () => {
    expect(
      resolveServerOwner(
        listener("/worktrees/task-other"),
        [thread("task", "/worktrees/task")],
        projects,
      ).threadId,
    ).toBeNull();
    const { managedProcess: _managedProcess, ...server } = listener(null);
    expect(
      resolveServerOwner(server, [thread("task", "/worktrees/task")], projects).threadId,
    ).toBeNull();
  });

  it("matches Windows worktrees with normalized separators and drive casing", () => {
    expect(
      resolveServerOwner(
        listener("c:\\worktrees\\TASK\\web"),
        [thread("task", "C:/worktrees/task/")],
        projects,
      ).threadId,
    ).toBe("task");
  });

  it("uses external process directories for association without granting process control", () => {
    const server: DiscoveredLocalServer = {
      host: "localhost",
      port: 5173,
      url: "http://localhost:5173",
      processName: "node",
      pid: 42,
      terminal: null,
      processDetails: {
        command: "node dev",
        cwd: "/worktrees/task/web",
        startTimeMs: 1000,
        parentPid: 1,
      },
    };
    expect(resolveServerOwner(server, [thread("task", "/worktrees/task")], projects)).toMatchObject(
      { threadId: "task", inferred: true },
    );
    expect(server.managedProcess).toBeUndefined();
    expect(
      resolveServerOwner(
        { ...server, processDetails: { ...server.processDetails!, cwd: "/projects/example/web" } },
        [thread("task", null)],
        projects,
      ),
    ).toMatchObject({ threadId: null, projectName: "Example" });
  });
});
