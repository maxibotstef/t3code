import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { clearActivatedServerRuntimeFiles, persistActivatedServerRuntimeFiles } from "./server.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("persists attach credentials privately and clears them on shutdown", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-attach-state-test-",
      });
      const statePath = path.join(root, "runtime", "server-attach.json");
      const state = yield* ServerRuntimeState.makePersistedServerAttachCredential({
        environmentId: EnvironmentId.make("attach-environment"),
        serverVersion: "0.0.37-nightly.20260904",
        credential: "attach-credential",
      });

      yield* ServerRuntimeState.persistServerAttachCredential({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerAttachCredential(statePath);
      const info = yield* fileSystem.stat(statePath);
      assert.deepEqual(Option.getOrThrow(restored), state);
      assert.equal(info.mode & 0o777, 0o600);

      yield* ServerRuntimeState.clearPersistedServerAttachCredential(statePath);
      assert.isFalse(yield* fileSystem.exists(statePath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes and clears attach lifecycle files in commit-marker order", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-attach-lifecycle-test-",
      });
      const operations: string[] = [];
      const trackedFileSystem = {
        ...fileSystem,
        rename: (fromPath: string, toPath: string) =>
          Effect.sync(() => {
            operations.push(`write:${path.basename(toPath)}`);
          }).pipe(Effect.andThen(fileSystem.rename(fromPath, toPath))),
        remove: (
          filePath: string,
          options?: { readonly force?: boolean; readonly recursive?: boolean },
        ) =>
          Effect.sync(() => {
            operations.push(`clear:${path.basename(filePath)}`);
          }).pipe(Effect.andThen(fileSystem.remove(filePath, options))),
      };
      const environmentId = EnvironmentId.make("attach-lifecycle-environment");
      const config = {
        desktopAttachCredential: "attach-lifecycle-credential",
        serverAttachCredentialPath: path.join(root, "server-attach.json"),
        serverRuntimeStatePath: path.join(root, "server-runtime.json"),
      };
      const environment = ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Attach lifecycle",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.37",
          capabilities: { repositoryIdentity: true },
        }),
      });

      yield* persistActivatedServerRuntimeFiles({
        config,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-09-04T00:00:00.000Z",
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
      );
      assert.deepEqual(operations, ["write:server-attach.json", "write:server-runtime.json"]);
      assert.isTrue(yield* fileSystem.exists(config.serverAttachCredentialPath));
      assert.isTrue(yield* fileSystem.exists(config.serverRuntimeStatePath));

      operations.length = 0;
      yield* clearActivatedServerRuntimeFiles(config).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );
      assert.deepEqual(operations, ["clear:server-runtime.json", "clear:server-attach.json"]);
      assert.isFalse(yield* fileSystem.exists(config.serverRuntimeStatePath));
      assert.isFalse(yield* fileSystem.exists(config.serverAttachCredentialPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rotates the attach credential for each server activation", () =>
    Effect.gen(function* () {
      const first = yield* ServerRuntimeState.generateServerAttachCredential;
      const second = yield* ServerRuntimeState.generateServerAttachCredential;

      assert.match(first, /^[0-9a-f]{48}$/);
      assert.match(second, /^[0-9a-f]{48}$/);
      assert.notEqual(first, second);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
