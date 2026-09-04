import { DesktopEnvironmentBootstrapSchema, EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendAttachment from "../../backend/DesktopBackendAttachment.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  pickProjectFavicon,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const decodeBootstraps = Schema.decodeUnknownEffect(
  Schema.Array(DesktopEnvironmentBootstrapSchema),
);

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes an attached owner with its external environment identity", () =>
    Effect.gen(function* () {
      const attachment = yield* DesktopBackendAttachment.DesktopBackendAttachment;
      const environmentId = EnvironmentId.make("existing-environment");
      yield* attachment.setReady({
        environmentId,
        label: "Existing T3",
        httpBaseUrl: "http://127.0.0.1:49731",
        wsBaseUrl: "ws://127.0.0.1:49731",
        credential: "attach-credential",
        runtimeState: {
          version: 1,
          pid: 123,
          port: 49_731,
          origin: "http://127.0.0.1:49731",
          startedAt: "2026-09-04T00:00:00.000Z",
        },
        attachCredential: {
          version: 1,
          environmentId,
          serverVersion: "0.0.37",
          credential: "attach-credential",
          createdAt: "2026-09-04T00:00:00.000Z",
        },
        descriptor: {
          environmentId,
          label: "Existing T3",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.37",
          capabilities: { repositoryIdentity: true },
        },
      });

      const result = yield* decodeBootstraps(yield* getLocalEnvironmentBootstraps.handler());
      assert.deepEqual(result[0], {
        id: "attached:existing-environment",
        label: "Existing T3",
        httpBaseUrl: "http://127.0.0.1:49731",
        wsBaseUrl: "ws://127.0.0.1:49731",
        bootstrapToken: "attach-credential",
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          DesktopBackendPool.layerTest([defaultWslInstance]),
          DesktopBackendAttachment.layer,
        ),
      ),
    ),
  );

  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});

describe("pickProjectFavicon", () => {
  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      );

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
    }),
  );
});
