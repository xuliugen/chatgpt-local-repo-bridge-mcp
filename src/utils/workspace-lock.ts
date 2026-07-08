interface WorkspaceLockTicket {
  roots: string[];
  waitMs: number;
  release: () => void;
}

type ReleaseFn = () => void;

const workspaceWriteQueues = new Map<string, Promise<void>>();

export async function acquireWorkspaceWriteLocks(
  workspaceRoots: string[],
  _operation: string
): Promise<WorkspaceLockTicket> {
  const roots = Array.from(new Set(workspaceRoots)).sort((a, b) => a.localeCompare(b));
  const releaseFns: ReleaseFn[] = [];
  const startedAt = Date.now();

  try {
    for (const root of roots) {
      releaseFns.push(await acquireSingleWorkspaceWriteLock(root));
    }

    return {
      roots,
      waitMs: Date.now() - startedAt,
      release: () => {
        for (const release of releaseFns.reverse()) {
          release();
        }
      },
    };
  } catch (error) {
    for (const release of releaseFns.reverse()) {
      release();
    }
    throw error;
  }
}

export async function withWorkspaceWriteLocks<T>(
  workspaceRoots: string[],
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  const ticket = await acquireWorkspaceWriteLocks(workspaceRoots, operation);
  try {
    return await run();
  } finally {
    ticket.release();
  }
}

function acquireSingleWorkspaceWriteLock(workspaceRoot: string): Promise<ReleaseFn> {
  const previous = workspaceWriteQueues.get(workspaceRoot) ?? Promise.resolve();

  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });

  const next = previous.catch(() => undefined).then(() => current);
  workspaceWriteQueues.set(workspaceRoot, next);

  return previous
    .catch(() => undefined)
    .then(() => {
      let released = false;

      return () => {
        if (released) return;
        released = true;
        releaseCurrent();

        if (workspaceWriteQueues.get(workspaceRoot) === next) {
          workspaceWriteQueues.delete(workspaceRoot);
        }
      };
    });
}
