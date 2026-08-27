import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  SERVER_LOCK_FILENAME,
  acquireServerSingleton,
  processIsAlive,
  recordServerLockPort,
  releaseServerLock,
  serverLockPath,
} from "./serverSingleton.ts";

const layer = it.layer(NodeServices.layer);

const makeStateDir = Effect.fn("test.makeStateDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "t3-singleton-" });
});

/** A stale lock file, written without the module's own encoder on purpose. */
const staleHolder = (pid: number) =>
  `{"version":1,"pid":${pid},"startedAt":"2026-01-01T00:00:00.000Z"}`;

layer("serverSingleton", (it) => {
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

  it.effect("reclaims a lock whose owner is gone", () =>
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
        }),
      );
    }),
  );

  it.effect("reclaims a lock file left half-written by a crash", () =>
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

  it.effect("does not release a lock another process has reclaimed", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* fs.writeFileString(lockPath, staleHolder(4194304));

      yield* releaseServerLock(lockPath);
      // Evicting a live successor would recreate the very bug this prevents.
      assert.isTrue(yield* fs.exists(lockPath));
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

  it.effect("uses a lock file inside the state directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const path = yield* Path.Path;
      const lockPath = yield* serverLockPath(stateDir);
      assert.strictEqual(lockPath, path.join(stateDir, SERVER_LOCK_FILENAME));
    }),
  );

  it("treats the current process as alive and an impossible pid as dead", () => {
    assert.isTrue(processIsAlive(process.pid));
    assert.isFalse(processIsAlive(4194304));
    assert.isFalse(processIsAlive(0));
    assert.isFalse(processIsAlive(-1));
  });
});
