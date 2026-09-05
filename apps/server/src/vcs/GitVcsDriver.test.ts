import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError, VcsProcessExitError } from "@t3tools/contracts";
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
  "global-filter",
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
  "file-directory",
  "directory-file",
  "untracked-cache",
  "submodule",
  "alternating-worktrees",
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
      let restoredCount = 0;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const globalConfig = path.join(parent, "global-config");
      if (scenario === "global-filter")
        yield* fileSystem.writeFileString(globalConfig, '[filter "unused"]\n clean = cat\n');
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          writeFile: (target, data, options) => {
            if (target.includes("t3-checkpoint-index-")) restoredCount++;
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
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            vcsProcess.run(
              scenario === "global-filter"
                ? {
                    ...input,
                    env: { ...process.env, ...input.env, GIT_CONFIG_GLOBAL: globalConfig },
                  }
                : input,
            ),
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
      if (scenario === "submodule") {
        const sub = path.join(parent, "sub");
        yield* fileSystem.makeDirectory(sub);
        yield* git(["-C", sub, "init", "-b", "main"]);
        yield* git(["-C", sub, "config", "user.name", "Test"]);
        yield* git(["-C", sub, "config", "user.email", "test@example.invalid"]);
        yield* fileSystem.writeFileString(path.join(sub, "file"), "sub base");
        yield* git(["-C", sub, "add", "."]);
        yield* git(["-C", sub, "commit", "-m", "sub base"]);
        yield* git(["-c", "protocol.file.allow=always", "submodule", "add", sub, "sub"]);
        yield* git(["commit", "-am", "add submodule"]);
      }
      if (scenario === "directory-file") {
        yield* fileSystem.makeDirectory(path.join(cwd, "directory"));
        yield* write("directory/child", "child");
        yield* git(["add", "."]);
        yield* git(["commit", "-m", "directory"]);
      }
      if (scenario === "untracked-cache") {
        yield* git(["config", "core.untrackedCache", "true"]);
        yield* git(["update-index", "--untracked-cache"]);
      }
      if (scenario === "alternating-worktrees") {
        yield* git(["worktree", "add", "-b", "alternate", path.join(parent, "alternate")]);
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
      if (scenario === "global-filter" || scenario === "filter")
        assert.strictEqual(restoredCount, 0);
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
          "file-directory",
          "directory-file",
          "untracked-cache",
          "submodule",
        ].includes(scenario)
      ) {
        if (scenario === "attributes-removed" || scenario === "staged-attributes-removed")
          yield* fileSystem.remove(path.join(cwd, ".gitattributes"));
        if (scenario === "config-removed") yield* git(["config", "--unset", "core.autocrlf"]);
        if (scenario === "cached-edit") yield* write("a.txt", "edit\n");
        if (scenario === "file-directory") {
          yield* fileSystem.remove(path.join(cwd, "a.txt"));
          yield* fileSystem.makeDirectory(path.join(cwd, "a.txt"));
          yield* write("a.txt/child", "nested");
        }
        if (scenario === "directory-file") {
          yield* fileSystem.remove(path.join(cwd, "directory"), { recursive: true });
          yield* write("directory", "replacement");
        }
        if (scenario === "untracked-cache") {
          yield* write("new-untracked", "added after warm capture");
          yield* fileSystem.remove(path.join(cwd, "b.txt"));
          yield* write("a.txt", "dirty cached tree");
        }
        if (scenario === "submodule") {
          const sub = path.join(cwd, "sub");
          yield* git(["-C", sub, "config", "user.name", "Test"]);
          yield* git(["-C", sub, "config", "user.email", "test@example.invalid"]);
          yield* write("sub/file", "sub new commit");
          yield* git(["-C", sub, "commit", "-am", "sub change"]);
          yield* write("sub/file", "sub uncommitted");
        }
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
      if (scenario === "alternating-worktrees") {
        const originalCwd = cwd;
        const other = path.join(parent, "alternate");
        const otherIndex = path.resolve(
          other,
          (yield* driver.execute({
            operation: "fixture",
            cwd: other,
            args: ["rev-parse", "--git-path", "index"],
          })).stdout.trim(),
        );
        const otherBefore = yield* fileSystem.readFile(otherIndex);
        for (let i = 0; i < 4; i++) {
          cwd = i % 2 ? originalCwd : other;
          yield* write("a.txt", `worktree edit ${i}`);
          const env = {
            ...process.env,
            GIT_INDEX_FILE: path.join(parent, `alternate-baseline-${i}`),
          };
          yield* git(["read-tree", "HEAD"], env);
          yield* git(["add", "-A", "--", "."], env);
          const expected = (yield* git(["write-tree"], env)).stdout;
          yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
          assert.strictEqual(
            (yield* git(["rev-parse", `${checkpointRef}^{tree}`])).stdout,
            expected,
          );
        }
        assert.deepStrictEqual(yield* fileSystem.readFile(otherIndex), otherBefore);
        cwd = originalCwd;
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

for (const failure of [
  "corrupt",
  "add",
  "write-tree",
  "fresh",
  "commit-tree",
  "update-ref",
] as const) {
  it.effect(`checkpoint restored-index recovery is bounded for ${failure}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const process = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-" });
      let armed = false;
      let recovering = false;
      let restored = 0;
      let attempts = 0;
      let injected = 0;
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (target, bytes, options) => {
            if (armed && target.includes("t3-checkpoint-index-")) {
              restored++;
              if (failure === "corrupt") return fs.writeFileString(target, "broken index");
            }
            return fs.writeFile(target, bytes, options);
          },
        }),
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            Effect.gen(function* () {
              const capture =
                armed && input.operation === "GitVcsDriver.checkpoints.captureCheckpoint";
              if (capture && input.args[2] === "read-tree") attempts++;
              if (
                capture &&
                !recovering &&
                input.args[2] === (failure === "fresh" ? "add" : failure) &&
                (injected === 0 || failure === "fresh")
              ) {
                injected++;
                if (input.env?.GIT_INDEX_FILE) {
                  yield* fs.writeFileString(`${input.env.GIT_INDEX_FILE}.lock`, "injected lock");
                }
                return yield* new VcsProcessExitError({
                  operation: input.operation,
                  command: input.command,
                  cwd,
                  exitCode: 1,
                  detail: "injected checkpoint failure",
                });
              }
              return yield* process.run(input);
            }),
        }),
      );
      const git = (args: ReadonlyArray<string>) =>
        driver.execute({ operation: "fixture", cwd, args });
      yield* git(["init", "-b", "main"]);
      yield* git(["config", "user.name", "Test"]);
      yield* git(["config", "user.email", "test@example.invalid"]);
      yield* fs.writeFileString(path.join(cwd, "a"), "base");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "base"]);
      const indexPath = path.join(cwd, ".git/index");
      const before = yield* fs.readFile(indexPath);
      const ref = CheckpointRef.make("refs/t3/checkpoints/recovery");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
      const original = (yield* git(["rev-parse", ref])).stdout;
      yield* fs.writeFileString(path.join(cwd, "a"), "edit");
      armed = true;
      const result = yield* Effect.exit(
        driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref }),
      );
      const fails = ["fresh", "commit-tree", "update-ref"].includes(failure);
      assert.strictEqual(Exit.isFailure(result), fails);
      assert.strictEqual(restored, 1);
      assert.strictEqual(attempts, ["commit-tree", "update-ref"].includes(failure) ? 1 : 2);
      if (fails) assert.strictEqual((yield* git(["rev-parse", ref])).stdout, original);
      else assert.strictEqual((yield* git(["show", `${ref}:a`])).stdout, "edit");
      if (failure === "fresh") {
        assert.strictEqual(injected, 2);
        recovering = true;
        yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: ref });
        assert.strictEqual((yield* git(["show", `${ref}:a`])).stdout, "edit");
        assert.strictEqual(restored, 1, "failed cache was invalidated before the next capture");
        assert.strictEqual(attempts, 3);
      }
      assert.deepStrictEqual(yield* fs.readFile(indexPath), before);
      assert.isFalse(
        (yield* fs.readDirectory(path.join(cwd, ".git"))).some((n) =>
          n.startsWith("t3-checkpoint-index-"),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(VcsProcess.layer), Effect.provide(NodeServices.layer)),
  );
}
