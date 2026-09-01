import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import { makeServerLayer } from "./server.ts";
import { PersistedServerRuntimeState } from "./serverRuntimeState.ts";
import {
  SERVER_LOCK_FILENAME,
  SERVER_LOCK_DATABASE_FILENAME,
  SERVER_RUNTIME_STATE_FILENAME,
  acquireServerSingleton,
  isServerLockBusyError,
  processIsAlive,
  processIsAliveWith,
  recordServerLockPort,
  serverLockDatabasePath,
  serverLockPath,
} from "./serverSingleton.ts";

const layer = it.layer(NodeServices.layer);

const makeStateDir = Effect.fn("test.makeStateDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "t3-singleton-" });
});

/** A stale lock file, written without the module's own encoder on purpose. */
const staleHolder = (pid: number) =>
  `{"version":1,"ownerId":"stale-owner","pid":${pid},"startedAt":"2026-01-01T00:00:00.000Z"}`;

const PersistedServerRuntimeStateFromJson = Schema.fromJsonString(PersistedServerRuntimeState);
const encodeRuntimeState = Schema.encodeSync(PersistedServerRuntimeStateFromJson);

/** What a pre-lock server persists: its live pid and port, and no lock file. */
const legacyRuntimeState = (pid: number, port: number) =>
  `${encodeRuntimeState({
    version: 1,
    pid,
    port,
    origin: `http://127.0.0.1:${port}`,
    startedAt: "2026-08-27T12:00:00.000Z",
  })}\n`;

layer("serverSingleton", (it) => {
  it.effect("the full server layer refuses before opening persistence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectory({ prefix: "t3-singleton-server-layer-" });
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          const failure = yield* Layer.build(
            makeServerLayer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir))),
          ).pipe(Effect.scoped, Effect.flip);

          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
          assert.isFalse(yield* fs.exists(path.join(stateDir, "state.sqlite")));
        }),
      );
    }),
  );

  it.effect("claims a free directory and releases it on scope exit", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          assert.isTrue(yield* fs.exists(lockPath));
        }),
      );
      // Released on scope exit, so a restart is not blocked by its predecessor.
      assert.isFalse(yield* fs.exists(lockPath));
    }),
  );

  it.effect("refuses a second server while the first holds the directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          // The incident: a second server started against a held directory, found
          // its port taken, silently bound another, and corrupted shared state.
          return yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
        }),
      );
      assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
      if (failure._tag === "ServerAlreadyRunningError") {
        assert.strictEqual(failure.holderPid, process.pid);
        assert.include(failure.message, stateDir);
        assert.include(failure.message, "overwrite each other");
      }
    }),
  );

  it.effect("overwrites stale display metadata after its owner is gone", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      // pid 2^22 is above every /proc/sys/kernel/pid_max default, so it cannot
      // be live. A crashed server must not lock its own directory forever.
      yield* fs.writeFileString(lockPath, staleHolder(4194304));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* acquireServerSingleton(stateDir);
          assert.strictEqual(held, lockPath);
          const metadata = yield* fs.readFileString(lockPath);
          assert.notInclude(metadata, "stale-owner");
        }),
      );
    }),
  );

  it.effect("overwrites half-written display metadata after a crash", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* fs.writeFileString(lockPath, '{"version":1,"pid":');

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
        }),
      );
    }),
  );

  it.effect("does not remove display metadata replaced by another owner", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          yield* fs.writeFileString(lockPath, staleHolder(process.pid));
        }),
      );

      assert.isTrue(yield* fs.exists(lockPath));
      assert.include(yield* fs.readFileString(lockPath), "stale-owner");
    }),
  );

  it.effect("records the bound port so the next server can name it", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lockPath = yield* acquireServerSingleton(stateDir);
          yield* recordServerLockPort(lockPath, 3775);
          const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
          if (failure._tag === "ServerAlreadyRunningError") {
            assert.strictEqual(failure.holderPort, 3775);
            assert.include(failure.message, "listening on port 3775");
          }
        }),
      );
    }),
  );

  it.effect("keeps separate directories independent", () =>
    Effect.gen(function* () {
      const first = yield* makeStateDir();
      const second = yield* makeStateDir();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(first);
          // A dev server and the real one use different state dirs and must both run.
          yield* acquireServerSingleton(second);
        }),
      );
    }),
  );

  it.effect("keeps ownership and display metadata inside the state directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const path = yield* Path.Path;
      const lockPath = yield* serverLockPath(stateDir);
      const databasePath = yield* serverLockDatabasePath(stateDir);
      assert.strictEqual(lockPath, path.join(stateDir, SERVER_LOCK_FILENAME));
      assert.strictEqual(databasePath, path.join(stateDir, SERVER_LOCK_DATABASE_FILENAME));
    }),
  );

  it("treats the current process as alive and an impossible pid as dead", () => {
    assert.isTrue(processIsAlive(process.pid));
    assert.isFalse(processIsAlive(4194304));
    assert.isFalse(processIsAlive(0));
    assert.isFalse(processIsAlive(-1));
    assert.isTrue(
      processIsAliveWith(123, () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }),
    );
    assert.isFalse(
      processIsAliveWith(123, () => {
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }),
    );
  });

  it("recognizes Node and Bun SQLite busy errors", () => {
    assert.isTrue(
      isServerLockBusyError(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      ),
    );
    assert.isTrue(isServerLockBusyError(Object.assign(new Error("busy"), { errno: 5 })));
    assert.isFalse(isServerLockBusyError(new Error("disk I/O error")));
  });

  it.effect("refuses next to a live pre-lock server that wrote no lock", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // 0.0.34 and earlier persist their live pid here but never claim a lock:
      // the desktop auto-update transition. The upgrade must still refuse.
      yield* fs.writeFileString(
        path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME),
        legacyRuntimeState(process.pid, 3775),
      );

      const failure = yield* Effect.scoped(acquireServerSingleton(stateDir)).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
      if (failure._tag === "ServerAlreadyRunningError") {
        assert.strictEqual(failure.holderPid, process.pid);
        assert.strictEqual(failure.holderPort, 3775);
        assert.include(failure.message, SERVER_RUNTIME_STATE_FILENAME);
        assert.include(failure.message, "compatibility guard for this older");
        assert.include(failure.message, "Do not remove it while the recorded process is live");
        assert.notInclude(failure.message, "contains display metadata only");
      }
      // And it must not have claimed the directory it refused.
      assert.isFalse(yield* fs.exists(yield* serverLockPath(stateDir)));
    }),
  );

  it.effect("claims the directory when the pre-lock server's pid is gone", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Leftover state from a crashed legacy server must not wedge the upgrade.
      yield* fs.writeFileString(
        path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME),
        legacyRuntimeState(4194304, 3775),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* acquireServerSingleton(stateDir);
          assert.strictEqual(held, yield* serverLockPath(stateDir));
        }),
      );
    }),
  );

  it.effect("claims the directory when legacy runtime state is corrupt", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME),
        '{"version":1,"pid":',
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* acquireServerSingleton(stateDir);
          assert.strictEqual(held, yield* serverLockPath(stateDir));
        }),
      );
    }),
  );

  it.effect("updates port metadata atomically", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          yield* recordServerLockPort(lockPath, 3775);

          const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
          if (failure._tag === "ServerAlreadyRunningError") {
            assert.strictEqual(failure.holderPort, 3775);
          }
        }),
      );

      // No temp staging directory outlives the metadata update.
      const leftovers = yield* fs
        .readDirectory(stateDir)
        .pipe(
          Effect.map((entries) =>
            entries.filter((entry) => entry.startsWith(`.${SERVER_LOCK_FILENAME}.`)),
          ),
        );
      assert.deepStrictEqual(leftovers, []);
    }),
  );
});
