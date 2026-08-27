/**
 * One server per data directory.
 *
 * Two T3 Code servers pointed at the same `--base-dir` both open `state.sqlite`
 * and both write `settings.json`, and they overwrite each other. The observed
 * incident: a desktop app auto-updated to a newer server while the old one was
 * still running, the new process found its port taken, silently bound a random
 * one, and ran blind against shared state. The visible symptom was a settings
 * toggle that would not stick — hours away from the actual cause.
 *
 * Nothing about that is detectable after the fact, so the fix is to refuse at
 * startup. A second server against a held directory exits with one clear
 * message instead of corrupting state.
 *
 * ## Why a pid file rather than `flock`
 *
 * An advisory `flock` is the better primitive: the kernel drops it when the
 * holder dies, so a crashed server leaves nothing stale to clean up. Node has no
 * binding for it, and adding a native dependency to the server for one lock is a
 * worse trade than handling staleness here.
 *
 * So the lock is an atomically created file holding the owner's identity, and
 * liveness is checked with signal 0. The tradeoff is honest: if a server is
 * killed and its pid is later reused by an unrelated process, this refuses to
 * start until the file is removed. That is the safe direction to fail, and the
 * message names the file so recovery is one `rm`.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const SERVER_LOCK_FILENAME = "server.lock";

export const ServerLockHolder = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  startedAt: Schema.String,
  /** Absent until the server binds; the lock is taken before a port exists. */
  port: Schema.optional(Schema.Int),
});
export type ServerLockHolder = typeof ServerLockHolder.Type;

const ServerLockHolderFromJson = Schema.fromJsonString(ServerLockHolder);
const decodeHolder = Schema.decodeUnknownOption(ServerLockHolderFromJson);
const encodeHolder = Schema.encodeSync(ServerLockHolderFromJson);

export class ServerAlreadyRunningError extends Schema.TaggedErrorClass<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  {
    stateDir: Schema.String,
    lockPath: Schema.String,
    holderPid: Schema.Int,
    holderPort: Schema.optional(Schema.Int),
    holderStartedAt: Schema.String,
  },
) {
  override get message(): string {
    const where =
      this.holderPort === undefined
        ? `pid ${this.holderPid}`
        : `pid ${this.holderPid}, listening on port ${this.holderPort}`;
    return [
      "Another T3 Code server is already using this data directory.",
      "",
      `  data directory: ${this.stateDir}`,
      `  held by:        ${where}`,
      `  since:          ${this.holderStartedAt}`,
      "",
      "Two servers sharing one data directory overwrite each other's state.sqlite",
      "and settings.json. Stop the running server, or start this one with a",
      "different --base-dir.",
      "",
      `If that process is gone, remove ${this.lockPath} and start again.`,
    ].join("\n");
  }
}

export class ServerLockUnavailableError extends Schema.TaggedErrorClass<ServerLockUnavailableError>()(
  "ServerLockUnavailableError",
  {
    lockPath: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Could not claim the server lock at ${this.lockPath}: ${this.reason}`;
  }
}

/**
 * Whether a pid is a live process.
 *
 * `EPERM` means it exists and belongs to someone else, which still counts — a
 * server started under a different user is exactly the case that must not be
 * trampled.
 */
export const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readHolder = Effect.fn("serverSingleton.readHolder")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => ""));
  return Option.getOrUndefined(decodeHolder(raw));
});

/**
 * Claims the directory, or explains who holds it.
 *
 * A lock file whose owner is gone — or which is unreadable, which means a
 * half-written file from a crash mid-write — is reclaimed rather than treated as
 * a permanent block. Reclaiming re-races the exclusive create, so two servers
 * starting together still produce exactly one winner.
 */
const claimLock = Effect.fn("serverSingleton.claimLock")(function* (input: {
  readonly stateDir: string;
  readonly lockPath: string;
  readonly startedAt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const payload = encodeHolder({ version: 1, pid: process.pid, startedAt: input.startedAt });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    yield* fs.makeDirectory(path.dirname(input.lockPath), { recursive: true }).pipe(Effect.ignore);
    const created = yield* fs.writeFileString(input.lockPath, payload, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (created) return undefined;

    const holder = yield* readHolder(input.lockPath);
    if (holder !== undefined && processIsAlive(holder.pid)) {
      return new ServerAlreadyRunningError({
        stateDir: input.stateDir,
        lockPath: input.lockPath,
        holderPid: holder.pid,
        ...(holder.port === undefined ? {} : { holderPort: holder.port }),
        holderStartedAt: holder.startedAt,
      });
    }
    // Owner is gone, or the file is unreadable because a crash tore a write in
    // half. Reclaim and re-race the exclusive create, which still yields one
    // winner when two servers start together.
    yield* fs.remove(input.lockPath).pipe(Effect.ignore);
  }
  return new ServerLockUnavailableError({
    lockPath: input.lockPath,
    reason: "the lock was repeatedly reclaimed by another starting server",
  });
});

/** Releases only a lock this process still owns, so a reclaimer is never evicted. */
export const releaseServerLock = Effect.fn("serverSingleton.release")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(lockPath);
  if (holder !== undefined && holder.pid !== process.pid) return;
  yield* fs.remove(lockPath).pipe(Effect.ignore);
});

/**
 * Records the bound port on the lock we already hold.
 *
 * Only for the error message a *later* server prints: knowing the holder's port
 * turns "something else is running" into an address the user can open. Failure
 * is ignored — the lock's job is done once it is held.
 */
export const recordServerLockPort = Effect.fn("serverSingleton.recordPort")(function* (
  lockPath: string,
  port: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(lockPath);
  if (holder === undefined || holder.pid !== process.pid) return;
  yield* fs.writeFileString(lockPath, encodeHolder({ ...holder, port })).pipe(Effect.ignore);
});

export const serverLockPath = Effect.fn("serverSingleton.lockPath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_LOCK_FILENAME);
});

/**
 * Holds the data directory for the lifetime of the returned scope.
 *
 * Acquired before anything opens the database or binds a port, and released on
 * shutdown.
 */
export const acquireServerSingleton = Effect.fn("serverSingleton.acquire")(function* (
  stateDir: string,
) {
  const lockPath = yield* serverLockPath(stateDir);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const failure = yield* claimLock({ stateDir, lockPath, startedAt });
      if (failure !== undefined) return yield* failure;
      return lockPath;
    }),
    () => releaseServerLock(lockPath).pipe(Effect.ignore),
  );
});
