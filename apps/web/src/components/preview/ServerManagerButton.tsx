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
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
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
          <p className="truncate text-xs text-muted-foreground">
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
      <div className="min-w-0 pl-7 text-xs text-muted-foreground">
        <p className="truncate">
          {owner.projectName ??
            (server.managedProcess ? "T3 process" : "Outside T3 / ownership unknown")}
          {owner.threadTitle ? ` / ${owner.threadTitle}${owner.inferred ? " (inferred)" : ""}` : ""}
        </p>
        {server.managedProcess ? (
          <Tooltip>
            <TooltipTrigger render={<p className="truncate font-mono" />}>
              {server.managedProcess.command}
            </TooltipTrigger>
            <TooltipPopup>{server.managedProcess.command}</TooltipPopup>
          </Tooltip>
        ) : null}
        {message ? (
          <p role="alert" className="mt-1 text-destructive-foreground">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
