/**
 * One server per data directory.
 *
 * The server already relies on SQLite for cross-platform filesystem locking.
 * A dedicated lock database holds one write transaction for the process
 * lifetime: a crash releases the OS lock automatically, while another process
 * receives SQLITE_BUSY before it can open T3's real persistence or bind HTTP.
 *
 * `server.lock` is display-only metadata for the refusal message. It never
 * decides ownership; deleting it cannot release the SQLite lock.
 *
 * A pre-lock server has no lock database, so the first upgraded process also
 * checks `server-runtime.json` and refuses while that recorded pid is live.
 * That compatibility check starts only after the old binary publishes its
 * runtime state; an unmodified old binary cannot participate in a lock that
 * did not exist when it shipped.
 */
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

export const SERVER_LOCK_FILENAME = "server.lock";
export const SERVER_LOCK_DATABASE_FILENAME = "server-lock.sqlite";
export const SERVER_RUNTIME_STATE_FILENAME = "server-runtime.json";

export const ServerLockHolder = Schema.Struct({
  version: Schema.Literal(1),
  ownerId: Schema.String,
  pid: Schema.Int,
  startedAt: Schema.String,
  /** Absent until the server binds; ownership is already held in SQLite. */
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
    holderPid: Schema.optional(Schema.Int),
    holderPort: Schema.optional(Schema.Int),
    holderStartedAt: Schema.optional(Schema.String),
    legacyRuntimeStatePath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const holder =
      this.holderPid === undefined
        ? "another live T3 Code server"
        : this.holderPort === undefined
          ? `pid ${this.holderPid}`
          : `pid ${this.holderPid}, listening on port ${this.holderPort}`;
    const common = [
      "Another T3 Code server is already using this data directory.",
      "",
      `  data directory: ${this.stateDir}`,
      `  held by:        ${holder}`,
      ...(this.holderStartedAt === undefined ? [] : [`  since:          ${this.holderStartedAt}`]),
      "",
      "Two servers sharing one data directory overwrite each other's state.sqlite",
      "and settings.json. Connect to the running server, stop it cleanly, or use",
      "a different --base-dir.",
    ];
    if (this.legacyRuntimeStatePath !== undefined) {
      return [
        ...common,
        "",
        `${this.legacyRuntimeStatePath} is the compatibility guard for this older`,
        "server. Do not remove it while the recorded process is live.",
      ].join("\n");
    }
    return [
      ...common,
      "",
      `Ownership is released automatically when the process exits. ${this.lockPath}`,
      "contains display metadata only; removing it does not release a live owner.",
    ].join("\n");
  }
}

export class ServerLockUnavailableError extends Schema.TaggedErrorClass<ServerLockUnavailableError>()(
  "ServerLockUnavailableError",
  {
    lockPath: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the server ownership database at ${this.lockPath}.`;
  }
}

export const processIsAliveWith = (pid: number, sendSignal: (pid: number) => void): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    sendSignal(pid);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const processIsAlive = (pid: number): boolean =>
  processIsAliveWith(pid, (targetPid) => process.kill(targetPid, 0));

interface LockDatabase {
  readonly exec: (sql: string) => void;
  readonly close: () => void;
}

interface HeldServerLock {
  readonly database: LockDatabase;
  readonly lockPath: string;
  readonly ownerId: string;
}

class ServerLockAttemptError extends Data.TaggedError("ServerLockAttemptError")<{
  readonly cause: unknown;
}> {}

const readHolder = Effect.fn("serverSingleton.readHolder")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(lockPath)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
  return Option.getOrUndefined(decodeHolder(raw));
});

const closeDatabase = (database: LockDatabase) =>
  Effect.sync(() => {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A failed BEGIN has no transaction to roll back.
    }
    database.close();
  }).pipe(Effect.ignore);

const openLockDatabase = Effect.fn("serverSingleton.openDatabase")(function* (lockPath: string) {
  if (process.versions.bun !== undefined) {
    const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
    return yield* Effect.try({
      try: () => {
        const database = new Database(lockPath, { create: true });
        return {
          exec: (sql: string) => database.exec(sql),
          close: () => database.close(),
        } satisfies LockDatabase;
      },
      catch: (cause) => new ServerLockUnavailableError({ lockPath, operation: "open", cause }),
    });
  }

  const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
  return yield* Effect.try({
    try: () => {
      const database = new DatabaseSync(lockPath);
      return {
        exec: (sql: string) => database.exec(sql),
        close: () => database.close(),
      } satisfies LockDatabase;
    },
    catch: (cause) => new ServerLockUnavailableError({ lockPath, operation: "open", cause }),
  });
});

export const isServerLockBusyError = (cause: unknown): boolean => {
  const code =
    cause instanceof Error && "code" in cause ? String((cause as NodeJS.ErrnoException).code) : "";
  const errno =
    cause instanceof Error && "errno" in cause
      ? Number((cause as NodeJS.ErrnoException).errno)
      : undefined;
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    errno === 5 ||
    /database is (?:locked|busy)/i.test(message)
  );
};

/** A pre-lock server is live against this directory. */
export class LiveLegacyServerRuntime extends Data.TaggedError("LiveLegacyServerRuntime")<{
  readonly state: {
    readonly pid: number;
    readonly port: number;
    readonly startedAt: string;
  };
}> {}

const beginExclusiveWrite = Effect.fn("serverSingleton.beginExclusiveWrite")(function* (
  database: LockDatabase,
  lockPath: string,
) {
  const result = yield* Effect.try({
    try: () => {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
    },
    catch: (cause) => new ServerLockAttemptError({ cause }),
  }).pipe(
    Effect.as({ ok: true as const }),
    Effect.catch((error) => Effect.succeed({ ok: false as const, cause: error.cause })),
  );
  if (result.ok) return true;
  if (isServerLockBusyError(result.cause)) return false;
  return yield* new ServerLockUnavailableError({
    lockPath,
    operation: "lock",
    cause: result.cause,
  });
});

export const serverLockPath = Effect.fn("serverSingleton.lockPath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_LOCK_FILENAME);
});

export const serverLockDatabasePath = Effect.fn("serverSingleton.databasePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_LOCK_DATABASE_FILENAME);
});

export const legacyServerRuntimeStatePath = Effect.fn("serverSingleton.legacyStatePath")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME);
});

const acquireLock = Effect.fn("serverSingleton.acquireLock")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const lockPath = yield* serverLockPath(stateDir);
  const databasePath = yield* serverLockDatabasePath(stateDir);
  const legacyRuntimeStatePath = yield* legacyServerRuntimeStatePath(stateDir);

  const legacyState = yield* readPersistedServerRuntimeState(legacyRuntimeStatePath);
  if (Option.isSome(legacyState) && processIsAlive(legacyState.value.pid)) {
    return yield* new LiveLegacyServerRuntime({ state: legacyState.value });
  }

  yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
  const database = yield* openLockDatabase(databasePath);
  return yield* Effect.gen(function* () {
    if (!(yield* beginExclusiveWrite(database, databasePath))) {
      const holder = yield* readHolder(lockPath);
      return yield* new ServerAlreadyRunningError({
        stateDir,
        lockPath,
        ...(holder === undefined
          ? {}
          : {
              holderPid: holder.pid,
              holderStartedAt: holder.startedAt,
              ...(holder.port === undefined ? {} : { holderPort: holder.port }),
            }),
      });
    }

    const ownerId = yield* crypto.randomUUIDv4;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* writeFileStringAtomically({
      filePath: lockPath,
      contents: encodeHolder({ version: 1, ownerId, pid: process.pid, startedAt }),
    });
    return { database, lockPath, ownerId } satisfies HeldServerLock;
  }).pipe(Effect.onError(() => closeDatabase(database)));
});

const releaseLock = Effect.fn("serverSingleton.releaseLock")(function* (held: HeldServerLock) {
  const fs = yield* FileSystem.FileSystem;
  const holder = yield* readHolder(held.lockPath).pipe(Effect.orElseSucceed(() => undefined));
  if (holder?.ownerId === held.ownerId) {
    // Remove metadata while the SQLite transaction still excludes successors.
    yield* fs.remove(held.lockPath, { force: true }).pipe(Effect.ignore);
  }
  yield* closeDatabase(held.database);
});

/** Records the bound port in display metadata while SQLite owns the lock. */
export const recordServerLockPort = Effect.fn("serverSingleton.recordPort")(function* (
  lockPath: string,
  port: number,
) {
  const holder = yield* readHolder(lockPath);
  if (holder === undefined || holder.pid !== process.pid) return;
  yield* writeFileStringAtomically({
    filePath: lockPath,
    contents: encodeHolder({ ...holder, port }),
  }).pipe(Effect.ignore);
});

/** Holds the state directory until the caller's scope closes. */
export const acquireServerSingleton = Effect.fn("serverSingleton.acquire")(function* (
  stateDir: string,
) {
  const legacyRuntimeStatePath = yield* legacyServerRuntimeStatePath(stateDir);
  return yield* Effect.acquireRelease(
    acquireLock(stateDir).pipe(
      Effect.catchTags({
        LiveLegacyServerRuntime: (legacy) =>
          Effect.fail(
            new ServerAlreadyRunningError({
              stateDir,
              lockPath: legacyRuntimeStatePath,
              holderPid: legacy.state.pid,
              holderPort: legacy.state.port,
              holderStartedAt: legacy.state.startedAt,
              legacyRuntimeStatePath,
            }),
          ),
      }),
    ),
    releaseLock,
  ).pipe(Effect.map((held) => held.lockPath));
});
