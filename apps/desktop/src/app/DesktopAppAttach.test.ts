// @effect-diagnostics nodeBuiltinImport:off - Temp state files exercise attach recovery.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopEnvironmentBootstrapSchema, EnvironmentId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackendAttachment from "../backend/DesktopBackendAttachment.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import { discoverDesktopBackend } from "../backend/DesktopBackendDiscovery.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import { getLocalEnvironmentBootstraps } from "../ipc/methods/window.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import { bootstrap, refreshAttachedBackend, resolveDesktopBackendLaunch } from "./DesktopApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";

const DESKTOP_VERSION = "0.0.37-nightly.20260904";
const ENVIRONMENT_ID = EnvironmentId.make("reattach-environment");
const decodeBootstraps = Schema.decodeUnknownEffect(
  Schema.Array(DesktopEnvironmentBootstrapSchema),
);

const writeRuntime = (stateDir: string, pid: number, origin = "http://127.0.0.1:49731") =>
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid,
      port: Number(new URL(origin).port),
      origin,
      startedAt: "2026-09-04T00:00:00.000Z",
    })}\n`,
  );

const writeAttach = (stateDir: string, credential: string) =>
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "server-attach.json"),
    `${JSON.stringify({
      version: 1,
      environmentId: ENVIRONMENT_ID,
      serverVersion: DESKTOP_VERSION,
      credential,
      createdAt: "2026-09-04T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );

const descriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "Existing T3",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: DESKTOP_VERSION,
  capabilities: { repositoryIdentity: true },
};

const makeDiscoveryLayers = (occupied = true) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(!occupied),
        isPortAvailableOnLoopback: () => Effect.succeed(!occupied),
        hasListenerOnHost: () => Effect.succeed(occupied),
        reserveLoopbackPort: () => Effect.die("unexpected port reservation"),
        findAvailablePort: () => Effect.die("unexpected port scan"),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(descriptor), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    ),
  );

let primaryStartCount = 0;
const primary: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Primary"),
  start: Effect.sync(() => {
    primaryStartCount += 1;
  }),
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.none()),
  snapshot: Effect.succeed({
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(false),
};

const testLayer = Layer.mergeAll(
  makeDiscoveryLayers(),
  DesktopBackendAttachment.layer,
  DesktopBackendPool.layerTest([primary]),
);

describe("Desktop attach recovery", () => {
  it.effect("spawns exactly once when no owner exists and 3773 is free", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-spawn-"));
    primaryStartCount = 0;
    return Effect.gen(function* () {
      const launch = yield* resolveDesktopBackendLaunch({
        configuredPort: Option.none(),
        stateDir,
        desktopVersion: DESKTOP_VERSION,
      });
      assert.deepEqual(launch, { _tag: "Spawn", port: 3773 });
      if (launch._tag === "Spawn") yield* primary.start;
      assert.equal(primaryStartCount, 1);
    }).pipe(Effect.provide(makeDiscoveryLayers(false)));
  });

  it.effect("bypasses discovery and preserves an explicit T3CODE_PORT", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-explicit-"));
    writeRuntime(stateDir, process.pid);
    writeAttach(stateDir, "would-attach-without-explicit-port");
    primaryStartCount = 0;
    return Effect.gen(function* () {
      const launch = yield* resolveDesktopBackendLaunch({
        configuredPort: Option.some(4_888),
        stateDir,
        desktopVersion: DESKTOP_VERSION,
      });
      assert.deepEqual(launch, { _tag: "Spawn", port: 4_888 });
      if (launch._tag === "Spawn") yield* primary.start;
      assert.equal(primaryStartCount, 1);
    }).pipe(Effect.provide(makeDiscoveryLayers()));
  });

  it.effect(
    "DesktopApp bootstrap attaches without starting a backend and targets the owner",
    () => {
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-bootstrap-"));
      writeRuntime(stateDir, process.pid);
      writeAttach(stateDir, "bootstrap-credential");
      primaryStartCount = 0;
      let primaryResolutionCount = 0;
      const protocolRegistrations: ElectronProtocol.DesktopProtocolRegistrationInput[] = [];
      const poolService = DesktopBackendPool.DesktopBackendPool.of({
        get: () => Effect.succeed(Option.none()),
        list: Effect.succeed([]),
        primary: Effect.sync(() => {
          primaryResolutionCount += 1;
          return primary;
        }),
        register: () => Effect.die("unexpected backend registration"),
        unregister: () => Effect.die("unexpected backend unregistration"),
      });
      const layer = Layer.mergeAll(
        makeDiscoveryLayers(),
        DesktopBackendAttachment.layer,
        Layer.succeed(DesktopBackendPool.DesktopBackendPool, poolService),
        DesktopState.layer,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          stateDir,
          appVersion: DESKTOP_VERSION,
          isDevelopment: false,
          configuredBackendPort: Option.none(),
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(
          DesktopAppSettings.DesktopAppSettings,
          {} as unknown as DesktopAppSettings.DesktopAppSettings["Service"],
        ),
        Layer.succeed(
          DesktopServerExposure.DesktopServerExposure,
          {} as unknown as DesktopServerExposure.DesktopServerExposure["Service"],
        ),
        Layer.succeed(
          ElectronProtocol.ElectronProtocol,
          ElectronProtocol.ElectronProtocol.of({
            registerDesktopProtocol: (input) =>
              Effect.sync(() => {
                protocolRegistrations.push(input);
              }),
          }),
        ),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          sendAll: () => Effect.void,
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Layer.succeed(
          DesktopIpc.DesktopIpc,
          DesktopIpc.DesktopIpc.of({
            handle: () => Effect.void,
            handleSync: () => Effect.void,
          }),
        ),
        Layer.succeed(PreviewManager.PreviewManager, {
          subscribeStateChanges: () => Effect.void,
          subscribePointerEvents: () => Effect.void,
          subscribeRecordingFrames: () => Effect.void,
        } as unknown as PreviewManager.PreviewManager["Service"]),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          handleBackendReady: () => Effect.void,
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Layer.succeed(
          DesktopWslBackend.DesktopWslBackend,
          {} as unknown as DesktopWslBackend.DesktopWslBackend["Service"],
        ),
      );

      const program = Effect.gen(function* () {
        yield* bootstrap;
        const bootstraps = yield* decodeBootstraps(yield* getLocalEnvironmentBootstraps.handler());
        assert.deepEqual(bootstraps[0], {
          id: `attached:${ENVIRONMENT_ID}`,
          label: "Existing T3",
          httpBaseUrl: "http://127.0.0.1:49731/",
          wsBaseUrl: "ws://127.0.0.1:49731/",
          bootstrapToken: "bootstrap-credential",
        });
        assert.equal(primaryStartCount, 0);
        assert.equal(primaryResolutionCount, 0);
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        const instances = yield* pool.list;
        assert.equal(instances.length, 0);
        const snapshots = yield* Effect.forEach(instances, (instance) => instance.snapshot);
        assert.isTrue(
          snapshots.every(
            (snapshot) => snapshot.desiredRunning === false && Option.isNone(snapshot.activePid),
          ),
        );
        assert.equal(protocolRegistrations.length, 1);
        assert.equal(protocolRegistrations[0]?.targetOrigin.origin, "http://127.0.0.1:49731");
        assert.equal(protocolRegistrations[0]?.backendOrigin.origin, "http://127.0.0.1:49731");
      }).pipe(Effect.provide(layer));
      // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- The mock IPC registrar deliberately does not capture every handler service; attach bootstrap only executes the services provided above.
      return Effect.scoped(program as Effect.Effect<void, never, Scope.Scope>);
    },
  );

  it.effect("marks owner loss unready and re-reads the rotated credential on recovery", () => {
    primaryStartCount = 0;
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-recovery-"));
    writeRuntime(stateDir, process.pid);
    writeAttach(stateDir, "initial-credential");

    return Effect.gen(function* () {
      const attachment = yield* DesktopBackendAttachment.DesktopBackendAttachment;
      const initial = yield* discoverDesktopBackend({ stateDir, desktopVersion: DESKTOP_VERSION });
      assert.equal(initial._tag, "Attach");
      if (initial._tag !== "Attach") return;
      yield* attachment.setReady(initial.target);

      writeRuntime(stateDir, 4_194_305);
      yield* refreshAttachedBackend({
        stateDir,
        desktopVersion: DESKTOP_VERSION,
        expectedEnvironmentId: ENVIRONMENT_ID,
      });
      const lost = Option.getOrThrow(yield* attachment.current);
      assert.isFalse(lost.ready);
      const unavailableBootstraps = yield* decodeBootstraps(
        yield* getLocalEnvironmentBootstraps.handler(),
      );
      assert.deepEqual(unavailableBootstraps, [
        {
          id: `attached:${ENVIRONMENT_ID}`,
          label: "Existing T3",
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);

      writeRuntime(stateDir, process.pid, "http://127.0.0.1:49732");
      writeAttach(stateDir, "rotated-credential");
      yield* refreshAttachedBackend({
        stateDir,
        desktopVersion: DESKTOP_VERSION,
        expectedEnvironmentId: ENVIRONMENT_ID,
      });
      const recovered = Option.getOrThrow(yield* attachment.current);
      assert.isTrue(recovered.ready);
      assert.equal(recovered.target.credential, "rotated-credential");
      assert.equal(recovered.target.httpBaseUrl, "http://127.0.0.1:49732/");
      const recoveredBootstraps = yield* decodeBootstraps(
        yield* getLocalEnvironmentBootstraps.handler(),
      );
      assert.equal(recoveredBootstraps[0]?.bootstrapToken, "rotated-credential");
      assert.equal(recoveredBootstraps[0]?.httpBaseUrl, "http://127.0.0.1:49732/");
      assert.equal(primaryStartCount, 0);
    }).pipe(Effect.provide(testLayer));
  });
});
