import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { previewEnvironment } from "~/state/preview";
import { environmentProjects } from "~/state/projects";
import { environmentThreadShells } from "~/state/threads";
import { resolveServerOwner } from "./serverManagerLogic";

/** Share discovery and ownership work across every thread badge in an environment. */
export const serverManagerQuery = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((includeAllListeners: boolean) =>
    Atom.make((get) => {
      const result = get(
        previewEnvironment.discoveredServers({
          environmentId,
          input: includeAllListeners ? { includeAllListeners: true } : {},
        }),
      );
      const threads = get(environmentThreadShells.threadShellsAtom).filter(
        (thread) => thread.environmentId === environmentId,
      );
      const projects = get(environmentProjects.projectsAtom).filter(
        (project) => project.environmentId === environmentId,
      );
      return AsyncResult.map(result, (snapshot) => ({
        ...snapshot,
        servers: snapshot.servers.map((server) => ({
          server,
          owner: resolveServerOwner(server, threads, projects),
        })),
      }));
    }).pipe(Atom.withLabel("web-server-manager")),
  ),
);
