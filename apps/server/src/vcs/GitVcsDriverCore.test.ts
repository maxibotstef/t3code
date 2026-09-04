import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  FULL_WORKTREE_MATERIALIZATION_STATE,
  GitCommandError,
  type ReviewDiffFileContentsInput,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { makeGitVcsDriverCore, splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const worktreeMaterializationSha256ForTest = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

const writeMaterializationFixture = Effect.fn("writeMaterializationFixture")(function* (
  cwd: string,
  options: {
    readonly requiredOutsideCone?: boolean;
    readonly requiredMissingEverywhere?: boolean;
    readonly invalidSharedPath?: boolean;
    readonly invalidSharedValue?: unknown;
    readonly omitTaskCardCone?: boolean;
    readonly utf8Bom?: boolean;
  } = {},
) {
  const contract = {
    schemaVersion: "clawd.worktree-materialization-profiles.v1",
    taskContext: {
      taskCardRoot: "ops/stef-task",
      buildStateRoot: "ops/build-state",
      researchRoot: "ops/research",
    },
    sharedConePaths:
      options.invalidSharedValue !== undefined
        ? [options.invalidSharedValue]
        : options.invalidSharedPath
          ? ["/absolute-cone"]
          : options.omitTaskCardCone
            ? ["config", "ops/build-state"]
            : ["config", "ops/stef-task", "ops/build-state"],
    sharedRequiredPaths: ["config/worktree-materialization-profiles.json"],
    unsupportedTaskClasses: ["unclassified", "multi-domain", "live-runtime"],
    profiles: [
      { id: "full", mode: "full", conePaths: [], requiredPaths: [] },
      {
        id: "governance-review",
        mode: "sparse",
        conePaths: ["docs"],
        requiredPaths: options.requiredMissingEverywhere
          ? ["missing/never.txt"]
          : options.requiredOutsideCone
            ? ["outside/needed.txt"]
            : [],
      },
      {
        id: "brandt-source",
        mode: "sparse",
        conePaths: ["brandt-pattern-recognition"],
        requiredPaths: ["brandt-pattern-recognition/source.ts"],
      },
      {
        id: "trading-strategy-source",
        mode: "sparse",
        conePaths: ["strategies"],
        requiredPaths: ["strategies/source.ts"],
      },
    ],
  } as const;
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  const raw = `${options.utf8Bom ? "\uFEFF" : ""}${JSON.stringify(contract, null, 2)}\n`;
  yield* writeTextFile(cwd, "config/worktree-materialization-profiles.json", raw);
  yield* writeTextFile(cwd, "docs/spec.md", "# sparse\n");
  yield* writeTextFile(cwd, "ops/stef-task/task/stef-task.json", "{}\n");
  yield* writeTextFile(cwd, "ops/build-state/OC-1/proof.json", "{}\n");
  yield* writeTextFile(cwd, "outside/needed.txt", "needed\n");
  yield* writeTextFile(cwd, "brandt-pattern-recognition/source.ts", "export {};\n");
  yield* writeTextFile(cwd, "strategies/source.ts", "export {};\n");
  yield* writeTextFile(cwd, "excluded/large.txt", `${"x".repeat(1_000_000)}\n`);
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "materialization fixture"]);
  return {
    expectedContractSha256: NodeCrypto.createHash("sha256").update(raw).digest("hex"),
  };
});

const logicalWorkingTreeBytes = (
  root: string,
): Effect.Effect<number, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const visit = (candidate: string): Effect.Effect<number, PlatformError.PlatformError> =>
      Effect.gen(function* () {
        const infoOption = yield* fileSystem.stat(candidate).pipe(Effect.option);
        if (Option.isNone(infoOption)) return 0;
        const info = infoOption.value;
        if (info.type === "File") return Number(info.size);
        if (info.type !== "Directory") return 0;
        const names = yield* fileSystem.readDirectory(candidate);
        let total = 0;
        for (const name of names) {
          if (candidate === root && name === ".git") continue;
          total += yield* visit(pathService.join(candidate, name));
        }
        return total;
      });
    return yield* visit(root);
  });

it.effect("uses stable diagnostics for every parsed non-repository command", () => {
  const commands: Array<{ readonly args: ReadonlyArray<string>; readonly lcAll?: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) {
        return assert.fail("expected a standard Git command");
      }
      commands.push({
        args: command.args,
        ...(command.options.env?.LC_ALL ? { lcAll: command.options.env.LC_ALL } : {}),
      });
      return makeNonRepositoryHandle();
    }),
  );
  const nodeServicesLayer = Layer.merge(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const layer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfigLayer),
    Layer.provideMerge(nodeServicesLayer),
  );

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = "/repo";

    yield* driver.statusDetailsLocal(cwd);
    yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
    yield* driver.listRefs({ cwd });

    assert.deepStrictEqual(commands, [
      { args: ["status", "--porcelain=2", "--branch"], lcAll: "C" },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], lcAll: "C" },
      { args: ["rev-parse", "--git-common-dir"], lcAll: "C" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("invalidates origin remote cache when a driver mutation adds origin", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    const before = yield* driver.statusDetailsLocal(cwd);
    assert.equal(before.hasOriginRemote, false);

    yield* driver.ensureRemote({ cwd, preferredName: "origin", url: remote });

    const after = yield* driver.statusDetailsLocal(cwd);
    assert.equal(after.hasOriginRemote, true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("re-reads origin remote status after cache TTL expiry and bypassed invalidation", () =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);

    // First call caches hasOriginRemote = false (5-min TTL)
    assert.equal((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote, false);

    // Add origin via raw git (bypasses invalidation hook)
    yield* git(cwd, ["remote", "add", "origin", remote]);

    // Cache still has the stale false (TTL not yet expired)
    const stillCached = yield* driver.statusDetailsLocal(cwd);
    assert.equal(stillCached.hasOriginRemote, false);

    // Advance past the 5-minute TTL so the cache entry expires
    yield* TestClock.adjust("6 minutes");

    // After expiry, the next call re-executes and picks up the remote
    const afterExpiry = yield* driver.statusDetailsLocal(cwd);
    assert.equal(afterExpiry.hasOriginRemote, true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("coalesces concurrent ref pages into one repository snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnedArgs = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const remoteNamesScanCompleted = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          yield* Ref.update(spawnedArgs, (current) => [...current, command.args]);
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          const shouldDelay =
            isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false));
          if (shouldDelay) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Effect.sleep("8 seconds");
          }
          const handle = yield* delegate.spawn(command);
          const isRemoteNamesScan =
            command.args.length === 3 &&
            command.args[0] === "--git-dir" &&
            command.args[2] === "remote";
          return isRemoteNamesScan
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(remoteNamesScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      );
      const cwd = yield* makeTmpDir();
      const runGit = (args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.coalescedListRefs",
          cwd,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(["config", "user.email", "test@test.com"]);
      yield* runGit(["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(["add", "."]);
      yield* runGit(["commit", "-m", "initial commit"]);
      yield* Ref.set(spawnedArgs, []);

      const initialRequest = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(remoteNamesScanCompleted);
      yield* TestClock.adjust("6 seconds");
      const laterRequests = yield* Effect.all(
        Array.from({ length: 30 }, (_, index) =>
          driver.listRefs({
            cwd,
            refresh: true,
            query: `missing-${index}`,
            limit: 100,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(initialRequest);
      yield* Fiber.join(laterRequests);
      yield* driver.listRefs({ cwd, cursor: 1, limit: 100 });

      const firstSnapshotCommands = yield* Ref.get(spawnedArgs);
      const snapshotRefScans = firstSnapshotCommands.filter(
        (args) =>
          args.includes("for-each-ref") &&
          args.includes("refs/heads") &&
          args.includes("refs/remotes"),
      );
      const worktreeScans = firstSnapshotCommands.filter(
        (args) => args.includes("worktree") && args.includes("--porcelain"),
      );
      assert.equal(snapshotRefScans.length, 1);
      assert.equal(worktreeScans.length, 1);

      yield* driver.createRef({ cwd, refName: "feature/cache-invalidation" });
      const refreshed = yield* driver.listRefs({ cwd, limit: 100 });
      assert.equal(
        refreshed.refs.some((ref) => ref.name === "feature/cache-invalidation"),
        true,
      );
      const allCommands = yield* Ref.get(spawnedArgs);
      assert.equal(
        allCommands.filter(
          (args) =>
            args.includes("for-each-ref") &&
            args.includes("refs/heads") &&
            args.includes("refs/remotes"),
        ).length,
        2,
      );
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("retries an in-flight ref snapshot invalidated by a mutation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const firstWorktreeScanStarted = yield* Deferred.make<void>();
      const firstRefScanCompleted = yield* Deferred.make<void>();
      const releaseFirstWorktreeScan = yield* Deferred.make<void>();
      const delayFirstWorktreeScan = yield* Ref.make(true);
      const refScans = yield* Ref.make(0);
      const coordinatingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeScan =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeScan && (yield* Ref.getAndSet(delayFirstWorktreeScan, false))) {
            yield* Deferred.succeed(firstWorktreeScanStarted, undefined);
            yield* Deferred.await(releaseFirstWorktreeScan);
          }
          const handle = yield* delegate.spawn(command);
          const isRefScan =
            command.args.includes("for-each-ref") &&
            command.args.includes("refs/heads") &&
            command.args.includes("refs/remotes");
          if (!isRefScan) return handle;
          const scan = yield* Ref.updateAndGet(refScans, (count) => count + 1);
          return scan === 1
            ? ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: handle.exitCode.pipe(
                  Effect.tap(() => Deferred.succeed(firstRefScanCompleted, undefined)),
                ),
              })
            : handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coordinatingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const inFlight = yield* driver
        .listRefs({ cwd, refresh: true, limit: 100 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(firstWorktreeScanStarted);
      yield* Deferred.await(firstRefScanCompleted);

      yield* driver.createRef({ cwd, refName: "feature/during-refresh" });
      yield* Deferred.succeed(releaseFirstWorktreeScan, undefined);

      const refs = yield* Fiber.join(inFlight);
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/during-refresh"));
      assert.equal(yield* Ref.get(refScans), 2);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args[1] === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("fails a ref snapshot when for-each-ref exits unsuccessfully", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const snapshotAttempts = yield* Ref.make(0);
      const failingSnapshotSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("for-each-ref")) {
            yield* Ref.update(snapshotAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingSnapshotSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));

      const error = yield* driver.listRefs({ cwd, refresh: true }).pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.listRefs.snapshotRefs",
        detail: "Git ref snapshot enumeration failed.",
        exitCode: 128,
      });
      assert.equal(yield* Ref.get(snapshotAttempts), 1);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";
      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");
          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("refreshes the current branch after an external checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "external-checkout"]);

      const initialRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(initialRefs.refs.find((ref) => ref.name === initialBranch)?.current);

      // Raw execute intentionally bypasses the driver's mutation invalidation,
      // matching a checkout performed by another process.
      yield* driver.execute({
        operation: "GitVcsDriver.test.externalCheckout",
        cwd,
        args: ["checkout", "external-checkout"],
        timeoutMs: 10_000,
      });
      yield* TestClock.adjust("6 seconds");

      const refreshedRefs = yield* driver.listRefs({ cwd, refresh: true });
      assert.isTrue(refreshedRefs.refs.find((ref) => ref.name === "external-checkout")?.current);
      assert.isFalse(refreshedRefs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("backs off failed upstream refreshes across linked worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchAttempts = yield* Ref.make(0);
      const failingFetchSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args.includes("fetch") && command.args.includes("--quiet")) {
            yield* Ref.update(fetchAttempts, (count) => count + 1);
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingFetchSpawner),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(worktreesRoot, "linked");
      const runGit = (workingDirectory: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.upstreamRefreshBackoff",
          cwd: workingDirectory,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "initial commit"]);
      const initialBranch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      yield* runGit(remote, ["init", "--bare"]);
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", initialBranch]);
      yield* runGit(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* runGit(worktreePath, [
        "branch",
        "--set-upstream-to",
        `origin/${initialBranch}`,
        "feature/linked",
      ]);
      const rootCommonDir = (yield* runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
      const linkedCommonDir = (yield* runGit(worktreePath, [
        "rev-parse",
        "--git-common-dir",
      ])).stdout.trim();
      assert.equal(
        yield* fileSystem.realPath(pathService.resolve(cwd, rootCommonDir)),
        yield* fileSystem.realPath(pathService.resolve(worktreePath, linkedCommonDir)),
      );
      yield* Ref.set(fetchAttempts, 0);

      yield* driver.statusDetailsRemote(cwd);
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("29 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("59 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 3);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("process environment", () => {
    it.effect("preserves the caller locale for general Git subprocesses", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();

        const locale = yield* git(
          cwd,
          ["-c", 'alias.print-locale=!printf "%s" "$LC_ALL"', "print-locale"],
          { LC_ALL: "zh_CN.UTF-8" },
        );

        assert.equal(locale, "zh_CN.UTF-8");
      }),
    );
  });

  describe("structured errors", () => {
    it.effect("preserves structured spawn context and the platform cause", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.missingCwd",
            cwd,
            args: ["status", "--short"],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.missingCwd",
          command: "git",
          argumentCount: 2,
          cwd,
          detail: "Failed to spawn Git process.",
        });
        if (!(error.cause instanceof PlatformError.PlatformError)) {
          return assert.fail("expected the original platform error cause");
        }
        assert.equal(error.cause.reason._tag, "NotFound");
        assert.notInclude(error.detail, error.cause.message);
      }),
    );

    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
      }),
    );

    it.effect("recovers a structurally identified missing cwd as a non-repository", () =>
      Effect.gen(function* () {
        const parent = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const cwd = pathService.join(parent, "missing");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const [localStatus, remoteStatus, refs] = yield* Effect.all([
          driver.statusDetails(cwd),
          driver.statusDetailsRemote(cwd, { refreshUpstream: false }),
          driver.listRefs({ cwd }),
        ]);

        assert.equal(localStatus.isRepo, false);
        assert.equal(remoteStatus.isRepo, false);
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("does not wrap a remove-worktree command failure in a synthetic error", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const notAWorktree = pathService.join(cwd, "not-a-worktree");
        yield* fileSystem.makeDirectory(notAWorktree);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const error = yield* driver.removeWorktree({ cwd, path: notAWorktree }).pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.removeWorktree",
          command: "git",
          argumentCount: 3,
          cwd,
        });
        assert.notProperty(error, "cause");
        assert.notProperty(error, "stderr");
        assert.notInclude(error.detail, "Git command failed in");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0partial",
          stdoutTruncated: true,
        });

        assert.deepStrictEqual(paths, ["complete.txt"]);
      }),
    );

    it.effect("keeps the final path when NUL-separated git output is complete", () =>
      Effect.sync(() => {
        const paths = splitNullSeparatedGitStdoutPaths({
          stdout: "complete.txt\0final.txt",
          stdoutTruncated: false,
        });

        assert.deepStrictEqual(paths, ["complete.txt", "final.txt"]);
      }),
    );

    it.effect("honors whitespace filtering for worktree and branch previews", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#  test\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change whitespace"]);
        yield* writeTextFile(cwd, "README.md", "#   test\n");

        const included = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });
        const ignored = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: true,
        });

        assert.isNotEmpty(included.sources.find((source) => source.kind === "working-tree")?.diff);
        assert.isNotEmpty(included.sources.find((source) => source.kind === "branch-range")?.diff);
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "working-tree")?.diff,
          "",
        );
        assert.strictEqual(
          ignored.sources.find((source) => source.kind === "branch-range")?.diff,
          "",
        );
      }),
    );

    it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["config", "diff.noprefix", "true"]);
        yield* git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(cwd, ["checkout", "-b", "feature/noprefix"]);
        yield* writeTextFile(cwd, "README.md", "# committed change\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "committed change"]);
        yield* writeTextFile(cwd, "README.md", "# dirty change\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const preview = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef: initialBranch,
          ignoreWhitespace: false,
        });

        const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
        const branchRange = preview.sources.find((source) => source.kind === "branch-range")?.diff;
        assert.include(workingTree, "diff --git a/README.md b/README.md");
        assert.include(workingTree, "+++ b/untracked.txt");
        assert.include(branchRange, "diff --git a/README.md b/README.md");
      }),
    );

    it.effect("loads full file contents for working-tree diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "nested/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
      }),
    );

    it.effect("attributes working-tree filesystem failures to the failing operation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "missing.ts",
              newPath: "missing.ts",
            }),
          )
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.getReviewDiffFileContents.workingTree.fs.realPath",
          command: "fs.realPath",
          cwd,
          detail: "Could not resolve diff file 'missing.ts'.",
        });
      }),
    );

    it.effect("loads new and deleted files without reading their missing side", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
        yield* fileSystem.remove(pathService.join(cwd, "README.md"));

        const [added, deleted] = yield* Effect.all([
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, {
              changeType: "new",
              oldPath: "added.ts",
              newPath: "added.ts",
            }),
          ),
          driver.getReviewDiffFileContents(
            makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
          ),
        ]);

        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "export const added = true;\n",
        });
        assert.deepStrictEqual(deleted, {
          oldContents: "# test\n",
          newContents: "",
        });
      }),
    );

    it.effect("loads merge-base and head contents for branch diff expansion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "feature/context"]);
        yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "change readme"]);

        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: initialBranch,
            headRef: "feature/context",
          }),
        );

        assert.strictEqual(contents.oldContents, "# test\n");
        assert.strictEqual(contents.newContents, "# branch change\nunchanged context\n");
      }),
    );
  });

  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
      }),
    );

    it.effect("reports changes to a file named HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "HEAD", "first line\n");
        yield* git(cwd, ["add", "HEAD"]);
        yield* git(cwd, ["commit", "-m", "add HEAD file"]);
        yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.deepInclude(status.workingTree.files, {
          path: "HEAD",
          insertions: 1,
          deletions: 0,
        });
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("reports remote status on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

        const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }),
    );

    it.effect("can read cached remote divergence without fetching upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const updater = yield* makeTmpDir("git-vcs-driver-updater-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        yield* git(updater, ["clone", remote, "."]);
        yield* git(updater, ["config", "user.email", "test@test.com"]);
        yield* git(updater, ["config", "user.name", "Test"]);
        yield* writeTextFile(updater, "remote.txt", "remote\n");
        yield* git(updater, ["add", "remote.txt"]);
        yield* git(updater, ["commit", "-m", "remote commit"]);
        yield* git(updater, ["push", "origin", initialBranch]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
          refreshUpstream: false,
        });
        const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

        assert.equal(cachedStatus.behindCount, 0);
        assert.equal(refreshedStatus.behindCount, 1);
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
      }),
    );

    it.effect("makes background upstream status fetches non-interactive", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const envKeys = [
          "GCM_INTERACTIVE",
          "GIT_ASKPASS",
          "GIT_SSH",
          "GIT_TERMINAL_PROMPT",
          "SSH_ASKPASS",
          "SSH_ASKPASS_REQUIRE",
          "T3_TEST_SSH_ASKPASS_LOG",
        ] as const;
        const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "GCM_INTERACTIVE=%s\\n" "${GCM_INTERACTIVE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS=%s\\n" "${SSH_ASKPASS:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            'printf "SSH_ASKPASS_REQUIRE=%s\\n" "${SSH_ASKPASS_REQUIRE:-}" >> "$T3_TEST_SSH_ASKPASS_LOG"',
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.GCM_INTERACTIVE = "always";
          process.env.GIT_ASKPASS = "git-askpass";
          process.env.GIT_TERMINAL_PROMPT = "1";
          process.env.SSH_ASKPASS = "ssh-askpass";
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
            "GCM_INTERACTIVE=never",
            "GIT_ASKPASS=",
            "GIT_TERMINAL_PROMPT=0",
            "SSH_ASKPASS=",
            "SSH_ASKPASS_REQUIRE=never",
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const previous = previousEnv.get(key);
                if (previous === undefined) {
                  delete process.env[key];
                } else {
                  process.env[key] = previous;
                }
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("reports combined staged and unstaged edits to the same file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* git(cwd, ["commit", "-m", "add feature"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
        yield* git(cwd, ["add", "feature.ts"]);
        yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.hasWorkingTreeChanges, true);
        const file = status.workingTree.files.find((f) => f.path === "feature.ts");
        assert.ok(file);
        // HEAD has 1 line. Staged has 2 lines (+1). Unstaged has 3 lines (+2 from HEAD).
        // Combined net from HEAD: +2 insertions.
        assert.equal(file.insertions, 2);
        assert.equal(file.deletions, 0);
      }),
    );

    it.effect("reports staged file counts on unborn HEAD without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* writeTextFile(cwd, "initial.ts", "// first file\n");
        yield* git(cwd, ["add", "initial.ts"]);

        const status = yield* driver.statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.workingTree.files.length, 1);
        const file = status.workingTree.files[0];
        if (file) {
          assert.equal(file.path, "initial.ts");
          assert.equal(file.insertions, 1);
        }
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("optionally includes remote refs that match local branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const deduplicated = yield* driver.listRefs({ cwd });
        assert.equal(
          deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          false,
        );

        const complete = yield* driver.listRefs({ cwd, includeMatchingRemoteRefs: true });
        assert.equal(
          complete.refs.some((ref) => ref.name === initialBranch),
          true,
        );
        assert.equal(
          complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
          true,
        );

        const remoteOnly = yield* driver.listRefs({
          cwd,
          includeMatchingRemoteRefs: true,
          refKind: "remote",
          limit: 1,
        });
        assert.equal(remoteOnly.refs.length, 1);
        assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
        assert.equal(remoteOnly.refs[0]?.isRemote, true);
      }),
    );

    it.effect("marks the origin default ref as default when no local copy exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
        yield* git(cwd, ["branch", "-D", initialBranch]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
        assert.equal(remoteDefault?.isRemote, true);
        assert.equal(remoteDefault?.isDefault, true);
      }),
    );

    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect(
      "materializes an explicit hash-bound sparse worktree and expands only while clean",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
          const pathService = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const worktreePath = pathService.join(
            yield* makeTmpDir("git-worktrees-"),
            "sparse-materialized",
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const created = yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/sparse-materialized",
            materialization: {
              requestedProfileId: "governance-review",
              expectedContractSha256,
              taskId: "OC-1",
              taskSlug: "task",
              taskCardPath: "ops/stef-task/task/stef-task.json",
              scopePaths: ["docs/spec.md"],
              taskClasses: ["source-task"],
            },
          });

          if (!created.materialization) return assert.fail("expected materialization state");
          assert.equal(created.materialization.effectiveProfileId, "governance-review");
          assert.equal(created.materialization.mode, "sparse");
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "docs/spec.md")),
            true,
          );
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
            false,
          );
          assert.equal(yield* git(worktreePath, ["config", "--bool", "index.sparse"]), "false");
          assert.deepStrictEqual(
            yield* driver.verifyWorktreeMaterialization(worktreePath),
            created.materialization,
          );

          yield* writeTextFile(worktreePath, "dirty.txt", "dirty\n");
          const dirtyExpansion = yield* Effect.result(
            driver.expandWorktreeMaterializationFull(worktreePath, "must-refuse"),
          );
          assert.equal(dirtyExpansion._tag, "Failure");
          assert.equal(
            (yield* driver.verifyWorktreeMaterialization(worktreePath)).effectiveProfileId,
            "governance-review",
          );
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
            false,
          );
          yield* fileSystem.remove(pathService.join(worktreePath, "dirty.txt"));
          yield* writeTextFile(worktreePath, "docs/spec.md", "# tracked dirty\n");
          assert.equal(
            (yield* Effect.result(
              driver.expandWorktreeMaterializationFull(worktreePath, "must-refuse-tracked"),
            ))._tag,
            "Failure",
          );
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
            false,
          );
          yield* git(worktreePath, ["checkout", "--", "docs/spec.md"]);

          const expanded = yield* driver.expandWorktreeMaterializationFull(
            worktreePath,
            "test-expand",
          );
          assert.equal(expanded.effectiveProfileId, "full");
          assert.equal(
            yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
            true,
          );
        }),
    );

    it.effect("preserves remote-base tracking while pinning the created branch commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-worktree-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        yield* git(cwd, ["fetch", "origin"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "remote-tracking",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: `origin/${initialBranch}`,
          newRefName: "feature/remote-tracking",
          baseRefName: initialBranch,
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-TRACK",
            taskSlug: "remote-tracking",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(
          yield* git(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("pins the one matching remote branch before legacy DWIM worktree creation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-worktree-dwim-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-b", "remote-only"]);
        yield* git(cwd, ["push", "origin", "remote-only"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["branch", "-D", "remote-only"]);
        yield* git(cwd, ["fetch", "origin"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "remote-only-dwim",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: "remote-only",
          newRefName: "feature/remote-only-materialized",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-DWIM",
            taskSlug: "remote-only",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.worktree.refName, "feature/remote-only-materialized");
        assert.equal(
          yield* git(worktreePath, ["branch", "--show-current"]),
          "feature/remote-only-materialized",
        );
        assert.equal(
          yield* git(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/remote-only",
        );
      }),
    );

    it.effect("respects simple auto-setup when the local and remote branch names differ", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-worktree-simple-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", initialBranch]);
        yield* git(cwd, ["fetch", "origin"]);
        yield* git(cwd, ["config", "branch.autoSetupMerge", "simple"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "simple-auto-setup",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: `origin/${initialBranch}`,
          newRefName: "feature/simple-auto-setup",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-SIMPLE",
            taskSlug: "simple-auto-setup",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        const upstream = yield* driver.execute({
          operation: "test.simpleAutoSetup",
          args: ["rev-parse", "--abbrev-ref", "@{upstream}"],
          cwd: worktreePath,
          allowNonZeroExit: true,
        });
        assert.notEqual(upstream.exitCode, 0);

        yield* git(cwd, ["config", "branch.autoSetupMerge", ""]);
        const emptyModePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "empty-auto-setup",
        );
        yield* driver.createWorktree({
          cwd,
          path: emptyModePath,
          refName: `origin/${initialBranch}`,
          newRefName: "feature/empty-auto-setup",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-EMPTY",
            taskSlug: "empty-auto-setup",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        const emptyModeUpstream = yield* driver.execute({
          operation: "test.emptyAutoSetup",
          args: ["rev-parse", "--abbrev-ref", "@{upstream}"],
          cwd: emptyModePath,
          allowNonZeroExit: true,
        });
        assert.notEqual(emptyModeUpstream.exitCode, 0);
      }),
    );

    it.effect("inherits the start branch upstream when auto-setup is inherit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-worktree-inherit-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["config", "branch.autoSetupMerge", "inherit"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "inherit-auto-setup",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/inherit-auto-setup",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-INHERIT",
            taskSlug: "inherit-auto-setup",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(
          yield* git(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          `origin/${initialBranch}`,
        );
      }),
    );

    it.effect("keeps default worktree placement named after a project subdirectory", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const projectCwd = pathService.join(cwd, "nested-project");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(projectCwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd: projectCwd,
          path: null,
          refName: initialBranch,
          newRefName: "feature/nested-project-placement",
        });

        assert.equal(
          pathService.basename(pathService.dirname(created.worktree.path)),
          "nested-project",
        );
      }),
    );

    it.effect("keeps omitted materialization on the legacy stateless create path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "legacy-stateless",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/legacy-stateless",
        });

        const gitDir = yield* git(worktreePath, ["rev-parse", "--git-dir"]);
        assert.equal(created.materialization, undefined);
        assert.equal(
          yield* fileSystem.exists(
            pathService.join(
              pathService.resolve(worktreePath, gitDir),
              "worktree-materialization.json",
            ),
          ),
          false,
        );
        assert.deepStrictEqual(
          yield* driver.verifyWorktreeMaterialization(worktreePath),
          FULL_WORKTREE_MATERIALIZATION_STATE,
        );
      }),
    );

    it.effect("disables inherited sparse configuration for an ordinary full worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(cwd, ["config", "core.sparseCheckout", "true"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "inherited-sparse-full",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/inherited-sparse-full",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-INHERITED",
            taskSlug: "inherited-sparse",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(
          yield* git(worktreePath, ["config", "--bool", "core.sparseCheckout"]),
          "false",
        );
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "full");
      }),
    );

    it.effect("falls back to full before release when sparse required paths are absent", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          requiredOutsideCone: true,
        });
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "full-fallback");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/full-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        if (!created.materialization) return assert.fail("expected fallback materialization state");
        assert.equal(created.materialization.requestedProfileId, "governance-review");
        assert.equal(created.materialization.effectiveProfileId, "full");
        assert.equal(created.materialization.reason, "required-paths-missing");
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "outside/needed.txt")),
          true,
        );
      }),
    );

    it.effect("expand-full repairs missing and failed sparse identities", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, [
          "sparse-checkout",
          "set",
          "--cone",
          "--no-sparse-index",
          "config",
          "docs",
        ]);
        assert.equal(
          (yield* Effect.result(driver.verifyWorktreeMaterialization(cwd)))._tag,
          "Failure",
        );
        const repairedMissing = yield* driver.expandWorktreeMaterializationFull(
          cwd,
          "repair-missing-state",
        );
        assert.equal(repairedMissing.status, "ready");
        assert.equal(repairedMissing.effectiveProfileId, "full");
        assert.equal((yield* driver.verifyWorktreeMaterialization(cwd)).effectiveProfileId, "full");
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, "excluded/large.txt")), true);

        const sparsePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "failed-state-repair",
        );
        const created = yield* driver.createWorktree({
          cwd,
          path: sparsePath,
          refName: initialBranch,
          newRefName: "feature/failed-state-repair",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        if (!created.materialization) return assert.fail("expected materialization state");
        const gitDir = yield* git(sparsePath, ["rev-parse", "--git-dir"]);
        const statePath = pathService.join(
          pathService.resolve(sparsePath, gitDir),
          "worktree-materialization.json",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const failedState = JSON.parse(yield* fileSystem.readFileString(statePath));
        failedState.status = "failed";
        failedState.reason = "injected-terminal-failure";
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* fileSystem.writeFileString(statePath, `${JSON.stringify(failedState, null, 2)}\n`);
        assert.equal(
          (yield* Effect.result(driver.verifyWorktreeMaterialization(sparsePath)))._tag,
          "Failure",
        );
        const repairedFailed = yield* driver.expandWorktreeMaterializationFull(
          sparsePath,
          "repair-failed-state",
        );
        assert.equal(repairedFailed.status, "ready");
        assert.equal(repairedFailed.effectiveProfileId, "full");
        assert.equal(
          yield* fileSystem.exists(pathService.join(sparsePath, "excluded/large.txt")),
          true,
        );
      }),
    );

    it.effect("expand-full recovers a clean sparse worktree with unreadable state", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "unreadable-state-recovery",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/unreadable-state-recovery",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-STATE",
            taskSlug: "unreadable-state",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        const gitDir = yield* git(worktreePath, ["rev-parse", "--git-dir"]);
        yield* fileSystem.writeFileString(
          pathService.join(
            pathService.resolve(worktreePath, gitDir),
            "worktree-materialization.json",
          ),
          "{not-json\n",
        );

        const expanded = yield* driver.expandWorktreeMaterializationFull(
          worktreePath,
          "recover-unreadable-state",
        );

        assert.equal(expanded.effectiveProfileId, "full");
        assert.equal(expanded.mode, "full");
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "full");
      }),
    );

    it.effect("expand-full refuses failed source identity and branch setup states", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "failed-source-identity",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/failed-source-identity",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-IDENTITY",
            taskSlug: "failed-source-identity",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        const gitDir = yield* git(worktreePath, ["rev-parse", "--git-dir"]);
        const statePath = pathService.join(
          pathService.resolve(worktreePath, gitDir),
          "worktree-materialization.json",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const state = JSON.parse(yield* fileSystem.readFileString(statePath));
        yield* fileSystem.writeFileString(
          statePath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `${JSON.stringify({ ...state, status: "failed", reason: "materialized-head-mismatch" })}\n`,
        );

        const expansion = yield* Effect.result(
          driver.expandWorktreeMaterializationFull(worktreePath, "must-refuse"),
        );

        assert.equal(expansion._tag, "Failure");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const preserved = JSON.parse(yield* fileSystem.readFileString(statePath));
        assert.equal(preserved.status, "failed");
        assert.equal(preserved.reason, "materialized-head-mismatch");
      }),
    );

    it.effect("expand-full repopulates files when sparse config was already disabled", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "disabled-sparse-config",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/disabled-sparse-config",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
          false,
        );
        yield* git(worktreePath, ["config", "--worktree", "core.sparseCheckout", "false"]);
        assert.equal(
          (yield* Effect.result(driver.verifyWorktreeMaterialization(worktreePath)))._tag,
          "Failure",
        );
        const expanded = yield* driver.expandWorktreeMaterializationFull(
          worktreePath,
          "recover-disabled-sparse-config",
        );
        assert.equal(expanded.effectiveProfileId, "full");
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
          true,
        );
      }),
    );

    it.effect("falls back to full when an explicit sparse request has no task class", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "unclassified-fallback",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/unclassified-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/new-file.md"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "unsupported:unclassified");
      }),
    );

    it.effect("falls back to full for an unknown task-class token", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "unknown-class"),
          refName: initialBranch,
          newRefName: "feature/unknown-class",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["srouce-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "unsupported:srouce-task");
      }),
    );

    it.effect("falls back to full when the exact task card is absent at the pinned commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "missing-task-card"),
          refName: initialBranch,
          newRefName: "feature/missing-task-card",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/not-at-base/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "task-card-missing-at-base");
      }),
    );

    it.effect("carries a hash-bound generated task card into the sparse worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const taskCardPath = "ops/stef-task/generated/stef-task.json";
        const taskCardBytes = '{"issue":{"id":"OC-GENERATED"}}\n';
        yield* writeTextFile(cwd, taskCardPath, taskCardBytes);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const inheritedExcludePath = pathService.join(
          yield* makeTmpDir("git-global-excludes-"),
          "global-excludes",
        );
        yield* fileSystem.writeFileString(inheritedExcludePath, "*.local-only\n");
        yield* git(cwd, ["config", "core.excludesFile", inheritedExcludePath]);
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "generated-task-card",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/generated-task-card",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-GENERATED",
            taskSlug: "generated",
            taskCardPath,
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "governance-review");
        assert.match(created.materialization?.taskCardSha256 ?? "", /^[a-f0-9]{64}$/);
        assert.equal(yield* fileSystem.exists(pathService.join(worktreePath, taskCardPath)), true);
        assert.equal(yield* git(worktreePath, ["status", "--porcelain=v1"]), "");
        assert.equal(
          yield* git(cwd, ["config", "--get", "core.excludesFile"]),
          inheritedExcludePath,
        );
        assert.equal(yield* git(cwd, ["config", "--get", "extensions.worktreeConfig"]), "true");
        const worktreeExcludePath = yield* git(worktreePath, [
          "config",
          "--worktree",
          "--get",
          "core.excludesFile",
        ]);
        assert.notEqual(worktreeExcludePath, inheritedExcludePath);
        assert.equal(
          yield* fileSystem.readFileString(worktreeExcludePath),
          `*.local-only\n${taskCardPath}\n`,
        );
        yield* fileSystem.writeFileString(
          pathService.join(worktreePath, taskCardPath),
          '{"tampered":true}\n',
        );
        assert.equal(
          (yield* Effect.result(driver.verifyWorktreeMaterialization(worktreePath)))._tag,
          "Failure",
        );
        assert.equal(yield* git(worktreePath, ["status", "--porcelain=v1"]), "");
        const tamperedExpansion = yield* Effect.result(
          driver.expandWorktreeMaterializationFull(worktreePath, "must-not-rebind-generated-card"),
        );
        assert.equal(tamperedExpansion._tag, "Failure");
        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "excluded/large.txt")),
          false,
        );
        yield* fileSystem.writeFileString(
          pathService.join(worktreePath, taskCardPath),
          taskCardBytes,
        );
        const expanded = yield* driver.expandWorktreeMaterializationFull(
          worktreePath,
          "restored-generated-card",
        );
        assert.equal(expanded.effectiveProfileId, "full");
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "full");
      }),
    );

    it.effect("completes full fallback when generated task-card bytes change during checkout", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const taskCardPath = "ops/stef-task/generated-race/stef-task.json";
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const sourcePath = pathService.join(cwd, taskCardPath);
        yield* writeTextFile(cwd, taskCardPath, '{"issue":{"id":"OC-RACE"}}\n');
        const gitDir = yield* git(cwd, ["rev-parse", "--git-dir"]);
        const hookPath = pathService.join(cwd, gitDir, "hooks", "post-checkout");
        yield* fileSystem.writeFileString(
          hookPath,
          `#!/bin/sh\nprintf '%s\\n' '{"issue":{"id":"OC-CHANGED"}}' > '${sourcePath}'\n`,
        );
        yield* fileSystem.chmod(hookPath, 0o755);
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "generated-task-card-race",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/generated-task-card-race",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-RACE",
            taskSlug: "generated-race",
            taskCardPath,
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "task-card-materialization-failed");
        assert.equal(created.materialization?.taskCardPath, null);
        assert.equal(created.materialization?.taskCardSha256, null);
        assert.equal(created.materialization?.requiredPaths.includes(taskCardPath), false);
        assert.equal(yield* fileSystem.exists(pathService.join(worktreePath, taskCardPath)), false);
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "full");
      }),
    );

    it.effect("preserves inherited ignores when full fallback revisits a generated task card", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          requiredOutsideCone: true,
        });
        const taskCardPath = "ops/stef-task/generated-fallback/stef-task.json";
        yield* writeTextFile(cwd, taskCardPath, '{"issue":{"id":"OC-FALLBACK"}}\n');
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const inheritedExcludePath = pathService.join(
          yield* makeTmpDir("git-global-excludes-"),
          "global-excludes",
        );
        yield* fileSystem.writeFileString(inheritedExcludePath, "*.local-only\n");
        yield* git(cwd, ["config", "core.excludesFile", inheritedExcludePath]);
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "generated-task-card-fallback",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/generated-task-card-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-FALLBACK",
            taskSlug: "generated-fallback",
            taskCardPath,
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "required-paths-missing");
        const worktreeExcludePath = yield* git(worktreePath, [
          "config",
          "--worktree",
          "--get",
          "core.excludesFile",
        ]);
        assert.equal(
          yield* fileSystem.readFileString(worktreeExcludePath),
          `*.local-only\n${taskCardPath}\n`,
        );
      }),
    );

    it.effect("preserves the default XDG Git ignore when adding a generated task card", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const taskCardPath = "ops/stef-task/generated-xdg/stef-task.json";
        yield* writeTextFile(cwd, taskCardPath, '{"issue":{"id":"OC-XDG"}}\n');
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const xdgRoot = yield* makeTmpDir("git-xdg-config-");
        const defaultExcludePath = pathService.join(xdgRoot, "git", "ignore");
        yield* fileSystem.makeDirectory(pathService.dirname(defaultExcludePath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(defaultExcludePath, "*.xdg-only\n");
        const previousXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdgRoot;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previousXdg;
          }),
        );
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "generated-task-card-xdg",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/generated-task-card-xdg",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-XDG",
            taskSlug: "generated-xdg",
            taskCardPath,
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        const worktreeExcludePath = yield* git(worktreePath, [
          "config",
          "--worktree",
          "--get",
          "core.excludesFile",
        ]);
        assert.equal(
          yield* fileSystem.readFileString(worktreeExcludePath),
          `*.xdg-only\n${taskCardPath}\n`,
        );
      }),
    );

    it.effect("falls back to full when tracked task-card working bytes differ from the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* writeTextFile(
          cwd,
          "ops/stef-task/task/stef-task.json",
          '{"issue":{"id":"OC-DIRTY"}}\n',
        );
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "dirty-task-card"),
          refName: initialBranch,
          newRefName: "feature/dirty-task-card",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-DIRTY",
            taskSlug: "dirty",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "task-card-source-mismatch");
      }),
    );

    it.effect("hashes contract bytes from the pinned commit instead of working-tree drift", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const contractPath = pathService.join(cwd, "config/worktree-materialization-profiles.json");
        const contractRaw = yield* fileSystem.readFileString(contractPath);
        yield* fileSystem.writeFileString(contractPath, `${contractRaw} \n`);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "pinned-contract"),
          refName: initialBranch,
          newRefName: "feature/pinned-contract",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "governance-review");
        assert.equal(created.materialization?.contractSha256, expectedContractSha256);
      }),
    );

    it.effect("verifies committed materialization bytes with checkout EOL conversion", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        yield* git(cwd, ["config", "core.autocrlf", "true"]);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "autocrlf-materialization",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/autocrlf-materialization",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-EOL",
            taskSlug: "autocrlf",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "governance-review");
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "sparse");
        const expanded = yield* driver.expandWorktreeMaterializationFull(
          worktreePath,
          "autocrlf-expand",
        );
        assert.equal(expanded.taskCardSha256, created.materialization?.taskCardSha256);
        assert.equal((yield* driver.verifyWorktreeMaterialization(worktreePath)).mode, "full");
      }),
    );

    it.effect("hashes the exact committed UTF-8 BOM bytes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          utf8Bom: true,
        });
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "bom-materialization",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/bom-materialization",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-BOM",
            taskSlug: "bom",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "governance-review");
        assert.equal(created.materialization?.contractSha256, expectedContractSha256);
      }),
    );

    it.effect("drops unsafe task-card paths from ordinary full state", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "unsafe-full-card"),
          refName: initialBranch,
          newRefName: "feature/unsafe-full-card",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256: "a".repeat(64),
            taskId: "OC-FULL",
            taskSlug: "unsafe-full",
            taskCardPath: "../../outside.json",
            scopePaths: ["../../outside.ts"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.taskCardPath, null);
        assert.deepStrictEqual(created.materialization?.scopePaths, []);
      }),
    );

    it.effect("carries a valid generated task card through explicit full materialization", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const taskCardPath = "ops/stef-task/generated-full/stef-task.json";
        const taskCardBytes = '{"issue":{"id":"OC-FULL-CARD"}}\n';
        yield* writeTextFile(cwd, taskCardPath, taskCardBytes);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "generated-full-card",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/generated-full-card",
          materialization: {
            requestedProfileId: "full",
            expectedContractSha256,
            taskId: "OC-FULL-CARD",
            taskSlug: "generated-full",
            taskCardPath,
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.taskCardGenerated, true);
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(worktreePath, taskCardPath)),
          taskCardBytes,
        );
        assert.equal(yield* git(worktreePath, ["status", "--porcelain=v1"]), "");
      }),
    );

    it.effect(
      "falls back to full before a generated card can escape through a symlinked parent",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
          const pathService = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const outside = yield* makeTmpDir("generated-card-outside-");
          const outsideCard = pathService.join(outside, "stef-task.json");
          const taskCardBytes = '{"issue":{"id":"OC-SYMLINK"}}\n';
          yield* fileSystem.writeFileString(outsideCard, taskCardBytes);
          yield* fileSystem.symlink(outside, pathService.join(cwd, "ops", "stef-task", "escape"));
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "symlink task card parent"]);
          const worktreePath = pathService.join(
            yield* makeTmpDir("git-worktrees-"),
            "generated-card-parent-symlink",
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;

          const created = yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/generated-card-parent-symlink",
            materialization: {
              requestedProfileId: "governance-review",
              expectedContractSha256,
              taskId: "OC-SYMLINK",
              taskSlug: "generated-card-parent-symlink",
              taskCardPath: "ops/stef-task/escape/stef-task.json",
              scopePaths: ["docs/spec.md"],
              taskClasses: ["source-task"],
            },
          });

          assert.equal(created.materialization?.effectiveProfileId, "full");
          assert.equal(created.materialization?.reason, "task-card-materialization-failed");
          assert.equal(created.materialization?.taskCardPath, null);
          assert.equal(created.materialization?.taskCardSha256, null);
          assert.equal(yield* fileSystem.readFileString(outsideCard), taskCardBytes);
        }),
    );

    it.effect("falls back to full when the contract does not cone-cover task cards", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          omitTaskCardCone: true,
        });
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "uncovered-card-root"),
          refName: initialBranch,
          newRefName: "feature/uncovered-card-root",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-CONE",
            taskSlug: "uncovered-card-root",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });

        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "contract-unavailable");
      }),
    );

    it.effect("forces the schema-valid UI sentinel to full", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "ui-sentinel-fallback",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/ui-sentinel-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "invalid-context",
            taskSlug: "invalid-context",
            taskCardPath: "invalid",
            scopePaths: ["invalid"],
            taskClasses: ["unclassified"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "unsupported:unclassified");
      }),
    );

    it.effect("falls back to full on a mismatched expected contract hash", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "hash-mismatch-fallback",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/hash-mismatch-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256: "0".repeat(64),
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "hash-mismatch");
      }),
    );

    it.effect("persists a blocking marker when full fallback cannot satisfy required paths", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          requiredMissingEverywhere: true,
        });
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "terminal-fallback-failure",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const result = yield* Effect.result(
          driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/terminal-fallback-failure",
            materialization: {
              requestedProfileId: "governance-review",
              expectedContractSha256,
              taskId: "OC-1",
              taskSlug: "task",
              taskCardPath: "ops/stef-task/task/stef-task.json",
              scopePaths: ["docs/spec.md"],
              taskClasses: ["source-task"],
            },
          }),
        );
        assert.equal(result._tag, "Failure");
        const gitDir = yield* git(worktreePath, ["rev-parse", "--git-dir"]);
        const statePath = pathService.join(
          pathService.resolve(worktreePath, gitDir),
          "worktree-materialization.json",
        );
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const failedState = JSON.parse(yield* fileSystem.readFileString(statePath));
        assert.equal(failedState.status, "failed");
        assert.equal(
          failedState.reason,
          "required-paths-missing:full-fallback-required-paths-missing",
        );
        const verification = yield* Effect.result(
          driver.verifyWorktreeMaterialization(worktreePath),
        );
        assert.equal(verification._tag, "Failure");
      }),
    );

    it.effect("falls back to full when the repository contract has an invalid shared path", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
          invalidSharedPath: true,
        });
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "malformed-contract-fallback",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/malformed-contract-fallback",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-1",
            taskSlug: "task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/spec.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "full");
        assert.equal(created.materialization?.reason, "contract-unavailable");
      }),
    );

    it.effect("falls back to full for noncanonical or non-string contract paths", () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const [index, invalidSharedValue] of ["docs/../x", 123].entries()) {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd, {
            invalidSharedValue,
          });
          const created = yield* driver.createWorktree({
            cwd,
            path: pathService.join(
              yield* makeTmpDir("git-worktrees-"),
              `invalid-contract-path-${index}`,
            ),
            refName: initialBranch,
            newRefName: `feature/invalid-contract-path-${index}`,
            materialization: {
              requestedProfileId: "governance-review",
              expectedContractSha256,
              taskId: "OC-1",
              taskSlug: "task",
              taskCardPath: "ops/stef-task/task/stef-task.json",
              scopePaths: ["docs/spec.md"],
              taskClasses: ["source-task"],
            },
          });
          assert.equal(created.materialization?.effectiveProfileId, "full");
          assert.equal(created.materialization?.reason, "contract-unavailable");
        }
      }),
    );

    it.effect("keeps future scope paths in the cone when the exact task card is pinned", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "future-paths");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/future-paths",
          materialization: {
            requestedProfileId: "governance-review",
            expectedContractSha256,
            taskId: "OC-FUTURE",
            taskSlug: "future-task",
            taskCardPath: "ops/stef-task/task/stef-task.json",
            scopePaths: ["docs/future-file.md"],
            taskClasses: ["source-task"],
          },
        });
        assert.equal(created.materialization?.effectiveProfileId, "governance-review");
        assert.equal(created.materialization?.requiredPaths.includes("docs/future-file.md"), false);
        assert.equal(
          created.materialization?.declaredDynamicPaths?.includes("docs/future-file.md"),
          true,
        );
      }),
    );

    it.effect("materialization canary preserves full-index identity for every sparse profile", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const { expectedContractSha256 } = yield* writeMaterializationFixture(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const profiles = [
          ["governance-review", "docs/spec.md"],
          ["brandt-source", "brandt-pattern-recognition/source.ts"],
          ["trading-strategy-source", "strategies/source.ts"],
        ] as const;

        for (const [index, [profileId, scopePath]] of profiles.entries()) {
          const worktreesRoot = yield* makeTmpDir(`git-canary-${index}-`);
          const fullPath = pathService.join(worktreesRoot, "full");
          const sparsePath = pathService.join(worktreesRoot, "sparse");
          const full = yield* driver.createWorktree({
            cwd,
            path: fullPath,
            refName: initialBranch,
            newRefName: `canary/${index}/full`,
          });
          const sparse = yield* driver.createWorktree({
            cwd,
            path: sparsePath,
            refName: initialBranch,
            newRefName: `canary/${index}/sparse`,
            materialization: {
              requestedProfileId: profileId,
              expectedContractSha256,
              taskId: "OC-1",
              taskSlug: "task",
              taskCardPath: "ops/stef-task/task/stef-task.json",
              scopePaths: [scopePath],
              taskClasses: ["source-task"],
            },
          });
          if (!sparse.materialization) return assert.fail("expected sparse canary identity");
          assert.equal(sparse.materialization.effectiveProfileId, profileId);
          assert.equal(
            yield* git(fullPath, ["rev-parse", "HEAD^{tree}"]),
            yield* git(sparsePath, ["rev-parse", "HEAD^{tree}"]),
          );
          assert.equal(
            worktreeMaterializationSha256ForTest(yield* git(fullPath, ["ls-files", "--stage"])),
            worktreeMaterializationSha256ForTest(yield* git(sparsePath, ["ls-files", "--stage"])),
          );
          assert.equal(
            yield* git(fullPath, ["ls-tree", "-r", "HEAD"]),
            yield* git(sparsePath, ["ls-tree", "-r", "HEAD"]),
          );
          assert.equal(yield* git(sparsePath, ["status", "--porcelain=v1"]), "");
          const fullBytes = yield* logicalWorkingTreeBytes(fullPath);
          const sparseBytes = yield* logicalWorkingTreeBytes(sparsePath);
          assert.ok(sparseBytes <= fullBytes * 0.5, `${profileId}: ${sparseBytes}/${fullBytes}`);

          if (index === 0) {
            for (const hiddenPath of ["ops/stef-task/task/stef-task.json", scopePath]) {
              yield* fileSystem.remove(pathService.join(sparsePath, hiddenPath));
              assert.equal(
                (yield* Effect.result(driver.verifyWorktreeMaterialization(sparsePath)))._tag,
                "Failure",
              );
              yield* git(sparsePath, ["checkout", "--", hiddenPath]);
              assert.equal(
                (yield* driver.verifyWorktreeMaterialization(sparsePath)).effectiveProfileId,
                profileId,
              );
            }
          }

          const expanded = yield* driver.expandWorktreeMaterializationFull(
            sparsePath,
            "canary-expand-full",
          );
          assert.equal(expanded.effectiveProfileId, "full");
          assert.equal(
            yield* fileSystem.exists(pathService.join(sparsePath, "excluded/large.txt")),
            true,
          );
          assert.equal(full.materialization, undefined);
          assert.equal(
            (yield* driver.verifyWorktreeMaterialization(fullPath)).effectiveProfileId,
            "full",
          );
        }
      }),
    );

    it.effect.skipIf(process.env.T3_MATERIALIZATION_CANARY_REPO === undefined)(
      "materialization real-repository canary preserves every frozen profile",
      () =>
        Effect.gen(function* () {
          const sourceRepo = process.env.T3_MATERIALIZATION_CANARY_REPO!;
          const cloneRoot = yield* makeTmpDir("git-real-canary-");
          const pathService = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const repo = pathService.join(cloneRoot, "repo");
          yield* git(cloneRoot, [
            "clone",
            "--quiet",
            "--shared",
            "--no-checkout",
            sourceRepo,
            repo,
          ]);
          const pinnedCommit = yield* git(repo, ["rev-parse", "HEAD^{commit}"]);
          yield* git(repo, [
            "checkout",
            pinnedCommit,
            "--",
            "config/worktree-materialization-profiles.json",
          ]);
          yield* git(repo, ["read-tree", pinnedCommit]);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const contractResult = yield* driver.execute({
            operation: "GitVcsDriver.test.realCanaryContract",
            cwd: repo,
            args: ["show", `${pinnedCommit}:config/worktree-materialization-profiles.json`],
            maxOutputBytes: 1024 * 1024,
          });
          const contractRaw = Buffer.from(contractResult.stdout, "utf8");
          const expectedContractSha256 = NodeCrypto.createHash("sha256")
            .update(contractRaw)
            .digest("hex");
          const taskCardPath = (yield* git(repo, [
            "ls-tree",
            "-r",
            "--name-only",
            pinnedCommit,
            "ops/stef-task",
          ]))
            .split(/\r?\n/)
            .find((candidate) => candidate.endsWith("/stef-task.json"));
          if (!taskCardPath) return assert.fail("real repository needs a tracked task card");
          const fullTree = yield* git(repo, ["rev-parse", `${pinnedCommit}^{tree}`]);
          const fullIndexHash = worktreeMaterializationSha256ForTest(
            yield* git(repo, ["ls-files", "--stage"]),
          );
          const fullModesHash = worktreeMaterializationSha256ForTest(
            yield* git(repo, ["ls-tree", "-r", pinnedCommit]),
          );
          const fullBytes = (yield* git(repo, ["ls-tree", "-r", "-l", pinnedCommit]))
            .split(/\r?\n/)
            .reduce((total, line) => {
              const match = line.match(/^\d+\s+\w+\s+[a-f0-9]+\s+(\d+)\t/);
              return total + Number(match?.[1] ?? 0);
            }, 0);
          const allProfiles = [
            ["governance-review", "builds/task-queue/lib/build-state.js"],
            ["brandt-source", "brandt-pattern-recognition/runtime-config.js"],
            ["trading-strategy-source", "cot-data/build-latest-from-index.js"],
          ] as const;
          const requestedProfile = process.env.T3_MATERIALIZATION_CANARY_PROFILE;
          const profiles = requestedProfile
            ? allProfiles.filter(([profileId]) => profileId === requestedProfile)
            : allProfiles;
          if (requestedProfile && profiles.length !== 1) {
            return assert.fail(`unknown real canary profile: ${requestedProfile}`);
          }

          for (const [index, [profileId, scopePath]] of profiles.entries()) {
            const sparsePath = pathService.join(cloneRoot, `sparse-${index}`);
            const created = yield* driver.createWorktree({
              cwd: repo,
              path: sparsePath,
              refName: pinnedCommit,
              newRefName: `real-canary/${index}/sparse`,
              materialization: {
                requestedProfileId: profileId,
                expectedContractSha256,
                taskId: `OC-REAL-CANARY-${index + 1}`,
                taskSlug: `${profileId}-canary`,
                taskCardPath,
                scopePaths: [scopePath],
                taskClasses: ["source-task"],
              },
            });
            assert.equal(created.materialization?.effectiveProfileId, profileId);
            assert.equal(yield* git(sparsePath, ["rev-parse", "HEAD^{tree}"]), fullTree);
            assert.equal(
              worktreeMaterializationSha256ForTest(yield* git(sparsePath, ["ls-files", "--stage"])),
              fullIndexHash,
            );
            assert.equal(
              worktreeMaterializationSha256ForTest(
                yield* git(sparsePath, ["ls-tree", "-r", "HEAD"]),
              ),
              fullModesHash,
            );
            assert.equal(yield* git(sparsePath, ["status", "--porcelain=v1"]), "");
            const sparseBytes = yield* logicalWorkingTreeBytes(sparsePath);
            assert.ok(sparseBytes <= fullBytes * 0.5, `${profileId}: ${sparseBytes}/${fullBytes}`);
            for (const hiddenPath of [taskCardPath, scopePath]) {
              yield* fileSystem.remove(pathService.join(sparsePath, hiddenPath));
              assert.equal(
                (yield* Effect.result(driver.verifyWorktreeMaterialization(sparsePath)))._tag,
                "Failure",
              );
              yield* git(sparsePath, ["checkout", "--", hiddenPath]);
            }
            assert.equal(
              (yield* driver.expandWorktreeMaterializationFull(
                sparsePath,
                "real-canary-expand-full",
              )).effectiveProfileId,
              "full",
            );
          }
        }),
      300_000,
    );

    it.effect("preserves newline characters in worktree paths when listing refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

        const refs = yield* driver.listRefs({ cwd, refresh: true });
        const listedPath = refs.refs.find(
          (ref) => ref.name === "feature/newline-path",
        )?.worktreePath;

        if (typeof listedPath !== "string") {
          return assert.fail("expected the linked branch to include its worktree path");
        }
        assert.equal(
          yield* fileSystem.realPath(listedPath),
          yield* fileSystem.realPath(worktreePath),
        );
      }),
    );

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git refuses `file:` submodule transports by default (CVE-2022-39253)
        // and ignores repo-level config for it, so a local fixture needs the
        // env allowance. Real submodules are https/ssh and need none of this.
        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // A real submodule: `git worktree add` leaves these empty, which is
        // what silently strips shared tooling out of every new worktree.
        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        // Points at a repository that does not exist, so the checkout fails the
        // way an unreachable private remote would. Creation must still succeed.
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("allows worktree removal to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const removalStarted = yield* Deferred.make<void>();
        const delayedRemovalSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args[0] === "worktree" &&
              command.args[1] === "remove"
            ) {
              yield* Deferred.succeed(removalStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedRemovalSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "slow-removal");

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/slow-removal",
        });

        const removal = yield* driver
          .removeWorktree({ cwd, path: worktreePath, force: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(removalStarted);
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(removal);

        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("removes the same worktree path twice without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "shared");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/shared",
        });

        // Two threads can record the same worktree path; the second delete
        // must be a no-op instead of exit 128.
        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.removeWorktree({ cwd, path: worktreePath });
      }),
    );

    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        // Delete the directory behind git's back so the registration goes stale.
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);

        const reusedForSsh = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "git@github.com:pingdotgg/t3code.git",
        });
        assert.equal(reusedForSsh, "origin");

        const reusedForSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForSshScheme, "origin");

        const reusedForBareSshScheme = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://github.com/pingdotgg/t3code",
        });
        assert.equal(reusedForBareSshScheme, "origin");

        const reusedForSshPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code",
        });
        assert.equal(reusedForSshPort, "origin");

        const reusedForSshWithPort = yield* driver.ensureRemote({
          cwd,
          preferredName: "pingdotgg",
          url: "ssh://git@github.com:22/pingdotgg/t3code.git",
        });
        assert.equal(reusedForSshWithPort, "origin");

        const addedForFork = yield* driver.ensureRemote({
          cwd,
          preferredName: "octocat",
          url: "git@github.com:octocat/t3code.git",
        });
        assert.equal(addedForFork, "octocat");
        assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "selected[1].txt");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("creates a worktree from the latest fetched remote commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const peer = yield* makeTmpDir("git-peer-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "remote-change.txt", "remote\n");
        yield* git(peer, ["add", "remote-change.txt"]);
        yield* git(peer, ["commit", "-m", "remote change"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
        assert.notEqual(beforeFetch, remoteHead);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemote({ cwd, remoteName: "origin" });

        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: initialBranch,
          }),
          true,
        );
        assert.equal(
          yield* driver.remoteBranchExists({
            cwd,
            remoteName: "origin",
            refName: "local-only",
          }),
          false,
        );

        const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: initialBranch,
          fallbackRemoteName: "origin",
        });
        const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
          cwd,
          refName: `origin/${initialBranch}`,
          fallbackRemoteName: "origin",
        });

        assert.deepEqual(resolvedBase, {
          commitSha: remoteHead,
          remoteRefName: `origin/${initialBranch}`,
        });
        assert.deepEqual(explicitlyResolvedBase, resolvedBase);
        assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-fetched-worktrees-"),
          "fetched-origin",
        );
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: resolvedBase.commitSha,
          newRefName: "t3code/fetched-origin",
          baseRefName: resolvedBase.remoteRefName,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.gh-merge-base"),
          initialBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
          null,
        );
        const status = yield* driver.statusDetails(worktreePath);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.aheadOfDefaultCount, 0);
      }),
    );

    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect("allows pushes to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const delayedPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedPushSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* driver
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 seconds");
        const pushed = yield* Fiber.join(pushing);

        assert.deepInclude(pushed, {
          status: "pushed",
          setUpstream: true,
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("publishes a branch tracking its base under its own name, not the base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "dev"]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", "-b", "feature/x", "origin/dev"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(yield* git(remote, ["log", "-1", "--pretty=%s", "feature/x"]), "Add feature");
        assert.equal(yield* git(remote, ["rev-parse", "dev"]), devSha);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.gh-merge-base"), "dev");
      }),
    );

    it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
        yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
          "release/v2",
        );
      }),
    );

    it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
        yield* git(cwd, ["fetch", "my-org/upstream"]);
        // `checkout --track my-org/upstream/effect-atom` cannot name the local
        // branch `effect-atom`, so git keeps `upstream/effect-atom`. Its
        // upstream is still its published head.
        yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          "upstream/effect-atom",
        );
        yield* writeTextFile(cwd, "alias.txt", "alias\n");
        yield* driver.prepareCommitContext(cwd);
        yield* driver.commit(cwd, "Add alias update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "upstream/effect-atom",
          upstreamBranch: "my-org/upstream/effect-atom",
          setUpstream: false,
        });
        assert.equal(
          yield* git(remote, ["log", "-1", "--pretty=%s", "effect-atom"]),
          "Add alias update",
        );
      }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
