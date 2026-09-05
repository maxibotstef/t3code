import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;
  let observedOutputMode: VcsProcess.VcsProcessInput["outputMode"];

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
      outputMode: "error",
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
    assert.strictEqual(observedOutputMode, "error");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              observedOutputMode = input.outputMode;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

for (const scenario of [
  "clean",
  "dirty",
  "assume-unchanged",
  "skip-worktree",
  "split-index",
  "sparse",
  "attributes",
  "attributes-symlink",
  "filter",
  "unborn",
  "missing-index",
  "corrupt-index",
  "linked-worktree",
  "attributes-removed",
  "staged-attributes-removed",
  "config-removed",
  "head-changed",
  "cached-edit",
  "concurrent",
  "cache-write-failure",
] as const) {
  it.effect(`checkpoint tree matches fresh-index capture for ${scenario}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-checkpoint-equivalence-",
      });
      let cwd = path.join(parent, "repo");
      yield* fileSystem.makeDirectory(cwd);
      let failedCacheWrite = false;
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          writeFile: (target, data, options) => {
            if (scenario !== "cache-write-failure" || !target.includes("t3-checkpoint-index-")) {
              return fileSystem.writeFile(target, data, options);
            }
            failedCacheWrite = true;
            return fileSystem.writeFile(target, new Uint8Array([0])).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.badArgument({
                    module: "FileSystem",
                    method: "writeFile",
                    description: "injected partial cache write",
                  }),
                ),
              ),
            );
          },
        }),
      );
      const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
        driver.execute({
          operation: "GitVcsDriver.test.checkpoint",
          cwd,
          args,
          ...(env ? { env } : {}),
        });
      const write = (name: string, text: string) =>
        fileSystem.writeFileString(path.join(cwd, name), text);
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.email", "test@example.invalid"]);
      yield* git(["config", "user.name", "Checkpoint test"]);
      yield* write("a.txt", "base\n");
      yield* write("b.txt", "base\n");
      yield* write(".gitignore", "ignored.txt\n");
      if (scenario === "attributes-symlink")
        yield* fileSystem.symlink("a.txt", path.join(cwd, ".gitattributes"));
      if (scenario === "attributes-removed" || scenario === "config-removed") {
        yield* write("a.txt", "line\r\n");
        if (scenario === "attributes-removed")
          yield* write(".gitattributes", "*.txt text eol=lf\n");
        else yield* git(["config", "core.autocrlf", "true"]);
      }
      if (scenario !== "unborn") {
        yield* git(["add", "."]);
        yield* git(["commit", "-m", "base"]);
      }
      if (scenario === "linked-worktree") {
        yield* git(["worktree", "add", "-b", "linked", path.join(parent, "linked")]);
        cwd = path.join(parent, "linked");
        yield* write("a.txt", "linked edit\n");
      }
      if (scenario === "staged-attributes-removed") {
        yield* write("a.txt", "line\r\n");
        yield* write(".gitattributes", "*.txt text eol=lf\n");
        yield* git(["add", ".gitattributes"]);
      }
      if (scenario === "dirty") {
        yield* write("a.txt", "staged\n");
        yield* git(["add", "a.txt"]);
        yield* write("a.txt", "unstaged\n");
        yield* fileSystem.remove(path.join(cwd, "b.txt"));
        yield* write("new\nfile.txt", "untracked\n");
        yield* write("intent.txt", "intent to add\n");
        yield* git(["add", "-N", "intent.txt"]);
        yield* write("ignored.txt", "ignored\n");
        yield* fileSystem.symlink("a.txt", path.join(cwd, "link.txt"));
      }
      if (scenario === "assume-unchanged" || scenario === "skip-worktree") {
        yield* git(["update-index", `--${scenario}`, "a.txt"]);
        yield* write("a.txt", "hidden edit\n");
      }
      if (scenario === "split-index") yield* git(["update-index", "--split-index"]);
      if (scenario === "sparse") yield* git(["sparse-checkout", "init", "--cone"]);
      if (scenario === "attributes") {
        yield* write(".gitattributes", "*.txt text eol=lf\n");
        yield* write("a.txt", "line\r\n");
      }
      if (scenario === "filter") {
        yield* git(["config", "filter.fixture.clean", "cat"]);
        yield* write(".gitattributes", "*.txt filter=fixture\n");
      }
      const indexResult = yield* git(["rev-parse", "--git-path", "index"]);
      const indexPath = path.resolve(cwd, indexResult.stdout.trim());
      if (scenario === "missing-index") yield* fileSystem.remove(indexPath);
      if (scenario === "corrupt-index")
        yield* fileSystem.writeFileString(indexPath, "not an index");
      let before = yield* fileSystem.readFile(indexPath).pipe(Effect.orElseSucceed(() => null));
      const baselineEnv = { ...process.env, GIT_INDEX_FILE: path.join(parent, "baseline-index") };
      if (scenario !== "unborn") yield* git(["read-tree", "HEAD"], baselineEnv);
      yield* git(["add", "-A", "--", "."], baselineEnv);
      const baseline = yield* git(["write-tree"], baselineEnv);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/equivalence");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const actual = yield* git(["rev-parse", `${checkpointRef}^{tree}`]);
      assert.strictEqual(actual.stdout.trim(), baseline.stdout.trim());
      const warmRef = CheckpointRef.make("refs/t3/checkpoints/warm-equivalence");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: warmRef });
      if (scenario === "cache-write-failure") assert.isTrue(failedCacheWrite);
      assert.strictEqual(
        (yield* git(["rev-parse", `${warmRef}^{tree}`])).stdout.trim(),
        baseline.stdout.trim(),
      );
      if (
        [
          "attributes-removed",
          "staged-attributes-removed",
          "config-removed",
          "head-changed",
          "cached-edit",
        ].includes(scenario)
      ) {
        if (scenario === "attributes-removed" || scenario === "staged-attributes-removed")
          yield* fileSystem.remove(path.join(cwd, ".gitattributes"));
        if (scenario === "config-removed") yield* git(["config", "--unset", "core.autocrlf"]);
        if (scenario === "cached-edit") yield* write("a.txt", "edit\n");
        if (scenario === "head-changed") {
          yield* write("committed.txt", "new head\n");
          yield* git(["add", "."]);
          yield* git(["commit", "-m", "changed head"]);
          before = yield* fileSystem.readFile(indexPath);
        }
        const changedEnv = {
          ...process.env,
          GIT_INDEX_FILE: path.join(parent, "changed-baseline"),
        };
        yield* git(["read-tree", "HEAD"], changedEnv);
        yield* git(["add", "-A", "--", "."], changedEnv);
        const expected = yield* git(["write-tree"], changedEnv);
        yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
        assert.strictEqual(
          (yield* git(["rev-parse", `${checkpointRef}^{tree}`])).stdout.trim(),
          expected.stdout.trim(),
        );
      }
      if (scenario === "concurrent") {
        yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const ref = CheckpointRef.make(`refs/t3/checkpoints/concurrent-${index}`);
              yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
              assert.strictEqual(
                (yield* git(["rev-parse", `${ref}^{tree}`])).stdout.trim(),
                baseline.stdout.trim(),
              );
            }),
          { concurrency: 8 },
        );
      }
      assert.deepStrictEqual(
        yield* fileSystem.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
        before,
      );
      const common = yield* git(["rev-parse", "--git-common-dir"]);
      const remaining = yield* fileSystem.readDirectory(path.resolve(cwd, common.stdout.trim()));
      assert.isFalse(remaining.some((name) => name.startsWith("t3-checkpoint-index-")));
      if (scenario === "dirty") {
        yield* write("a.txt", "later edit\n");
        assert.isTrue(yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef }));
        assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "a.txt")), "unstaged\n");
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(cwd, "new\nfile.txt")),
          "untracked\n",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(VcsProcess.layer), Effect.provide(NodeServices.layer)),
  );
}
