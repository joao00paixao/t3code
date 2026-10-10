import { useAtomValue } from "@effect/atom-react";
import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { AuthDiagnosticsReadScope, AuthPreviewOperateScope } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { ExternalLink, RadioTower, Square } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentQuery } from "~/state/query";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { openDiscoveredPort } from "./openDiscoveredPort";
import type { resolveServerOwner } from "./serverManagerLogic";
import { serverManagerQuery } from "./serverManagerState";

export function ServerManagerButton({
  threadRef,
  compact = false,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [onlyThread, setOnlyThread] = useState(compact);
  const canInspect = useEnvironmentScope(threadRef.environmentId, AuthDiagnosticsReadScope);
  const state = useEnvironmentQuery(serverManagerQuery(threadRef.environmentId)(canInspect));
  const servers = state.data?.servers ?? [];
  const owned = servers.filter(({ owner }) => owner.threadId === threadRef.threadId);
  const visible = onlyThread ? owned : servers;

  if (compact && owned.length === 0) return null;
  return (
    <div
      role="presentation"
      className="inline-flex shrink-0"
      // Dialog portals still bubble through React's tree into the draggable
      // thread row. Server controls must not activate or rename that row.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <Button
        size={compact ? "micro" : "compact"}
        variant="ghost-muted"
        aria-label={
          compact ? `${owned.length} running servers for this thread` : "Manage running servers"
        }
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOnlyThread(compact);
          setOpen(true);
        }}
      >
        <RadioTower />
        {compact ? owned.length : `Servers${servers.length ? ` (${servers.length})` : ""}`}
      </Button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Running servers</DialogTitle>
              <DialogDescription>
                Listening ports on this environment. Closing a preview leaves its server running.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex items-center gap-1">
                <Button
                  size="compact"
                  variant={onlyThread ? "ghost-muted" : "secondary"}
                  aria-pressed={!onlyThread}
                  onClick={() => setOnlyThread(false)}
                >
                  All ({servers.length})
                </Button>
                <Button
                  size="compact"
                  variant={onlyThread ? "secondary" : "ghost-muted"}
                  aria-pressed={onlyThread}
                  onClick={() => setOnlyThread(true)}
                >
                  This thread ({owned.length})
                </Button>
              </div>
              {state.error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  Could not refresh servers: {state.error}
                </p>
              ) : null}
              {state.isPending && servers.length === 0 ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Looking for running servers…
                </p>
              ) : null}
              {!state.isPending && !state.error && visible.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {onlyThread
                    ? "No servers associated with this thread."
                    : "No listening servers found."}
                </p>
              ) : null}
              <div className="divide-y divide-border rounded-lg border border-border">
                {visible.map(({ server, owner }) => (
                  <ServerManagerRow
                    key={`${server.host}:${server.port}:${server.pid}:${server.managedProcess?.startTimeMs}`}
                    threadRef={threadRef}
                    server={server}
                    owner={owner}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {!canInspect
                  ? "Diagnostics access is required to list all listening ports. "
                  : state.data && !state.data.allListenerDiscovery
                    ? "This environment supports web-server discovery only. Update its server to list all ports. "
                    : ""}
                Stop is available for verified T3 child processes with maintenance access.
                Working-directory matches are marked as inferred; shared directories do not identify
                a thread.
              </p>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}

function ServerManagerRow({
  threadRef,
  server,
  owner,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly server: DiscoveredLocalServer;
  readonly owner: ReturnType<typeof resolveServerOwner>;
}) {
  const signal = useAtomCommand(serverEnvironment.signalProcess, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canStop = useAtomValue(
    serverEnvironment.signalProcess.permissionAtom(threadRef.environmentId),
  );
  const canPreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const previewAvailable = usePreviewAvailable(threadRef.environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const command = server.processDetails?.command ?? server.managedProcess?.command;
  const cwd = server.processDetails?.cwd ?? server.managedProcess?.cwd;
  const startedAt = server.processDetails?.startTimeMs ?? server.managedProcess?.startTimeMs;
  const stopExplanation = !server.managedProcess
    ? "This process is not tracked as a T3 child. Stop it in its terminal or application."
    : !server.managedProcess.canStop
      ? "T3 protects its own services and agent processes from being stopped here."
      : !canStop
        ? "Maintenance access is required to stop this process."
        : "T3 verified this child process. Stop sends an interrupt (SIGINT).";
  const stop = async () => {
    if (!server.pid || !server.managedProcess?.canStop || !canStop || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await signal({
        environmentId: threadRef.environmentId,
        input: {
          pid: server.pid,
          startTimeMs: server.managedProcess.startTimeMs,
          signal: "SIGINT",
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      if (result.value.signaled) setStopRequested(true);
      else setMessage(Option.getOrElse(result.value.message, () => "Could not stop this server."));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not stop this server.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const preview = async () => {
    setMessage(null);
    try {
      const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        throw squashAtomCommandFailure(result);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open preview.");
    }
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3">
        <RadioTower className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm tabular-nums">
            {server.host}:{server.port}
          </p>
          <p className="wrap-anywhere text-xs text-muted-foreground">
            {server.processName ?? "Unknown process"}
            {server.pid ? ` · PID ${server.pid}` : ""}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Open preview on port ${server.port}`}
          disabled={!canPreview || !previewAvailable}
          onClick={() => void preview()}
        >
          <ExternalLink />
        </Button>
        <Button
          size="compact"
          variant="ghost-destructive"
          disabled={!canStop || !server.managedProcess?.canStop || busy || stopRequested}
          onClick={() => void stop()}
          aria-label={`Stop server on port ${server.port}`}
        >
          <Square />
          {busy ? "Stopping…" : stopRequested ? "Stop requested" : "Stop"}
        </Button>
      </div>
      <div className="min-w-0 space-y-1 pl-7 text-xs text-muted-foreground">
        <p className="wrap-anywhere">
          {owner.projectName ??
            (server.managedProcess ? "T3 process" : "Outside T3 / ownership unknown")}
          {owner.threadTitle ? ` / ${owner.threadTitle}${owner.inferred ? " (inferred)" : ""}` : ""}
        </p>
        {command ? (
          <p className="line-clamp-2 select-text wrap-anywhere font-mono text-foreground">
            {command}
          </p>
        ) : (
          <p>Command unavailable.</p>
        )}
        {cwd ? <p className="select-text wrap-anywhere font-mono">{cwd}</p> : null}
        <details className="pt-1">
          <summary
            className="w-fit cursor-pointer rounded-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Details for server on port ${server.port}`}
          >
            Details
          </summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-md bg-muted/40 p-3">
            <dt>Command</dt>
            <dd className="select-text wrap-anywhere whitespace-pre-wrap font-mono text-foreground">
              {command ?? "Unavailable — process details could not be read."}
            </dd>
            <dt>Directory</dt>
            <dd className="select-text wrap-anywhere font-mono text-foreground">
              {cwd ?? "Unavailable — working directory could not be read."}
            </dd>
            <dt>Process</dt>
            <dd className="select-text wrap-anywhere text-foreground">
              {server.processName ?? "Unknown"}
              {server.pid ? ` · PID ${server.pid}` : ""}
            </dd>
            <dt>Parent PID</dt>
            <dd className="select-text font-mono text-foreground">
              {server.processDetails?.parentPid ?? "Unavailable"}
            </dd>
            <dt>Started</dt>
            <dd className="text-foreground">
              {startedAt !== undefined ? new Date(startedAt).toLocaleString() : "Unavailable"}
            </dd>
            <dt>Project</dt>
            <dd className="select-text wrap-anywhere text-foreground">
              {owner.projectName ?? "No matching project"}
            </dd>
            <dt>Thread</dt>
            <dd className="select-text wrap-anywhere text-foreground">
              {owner.threadTitle ?? "No unique thread identified"}
            </dd>
            <dt>Association</dt>
            <dd className="wrap-anywhere text-foreground">
              {server.terminal
                ? "Tracked T3 terminal"
                : owner.inferred
                  ? "Inferred from a unique thread working directory"
                  : owner.projectName
                    ? "Project working directory only; thread unknown"
                    : "No terminal or working directory match"}
            </dd>
            <dt>Preview URL</dt>
            <dd className="select-text wrap-anywhere font-mono text-foreground">{server.url}</dd>
            <dt>Stop</dt>
            <dd className="wrap-anywhere text-foreground">{stopExplanation}</dd>
          </dl>
          <p className="mt-2">
            Detected as a TCP listener. A listening port alone does not identify a web app.
          </p>
        </details>
        {message ? (
          <p role="alert" className="mt-1 text-destructive-foreground">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
