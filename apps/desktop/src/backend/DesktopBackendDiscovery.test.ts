// @effect-diagnostics nodeBuiltinImport:off - Temp state files exercise the desktop filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  DEFAULT_DESKTOP_BACKEND_PORT,
  discoverDesktopBackend,
  isDesktopBackendProcessAlive,
  type DesktopBackendRefusalReason,
} from "./DesktopBackendDiscovery.ts";

const DESKTOP_VERSION = "0.0.37-nightly.20260904";
const ENVIRONMENT_ID = EnvironmentId.make("desktop-discovery-environment");

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  environmentId: ENVIRONMENT_ID,
  label: "Existing T3",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: DESKTOP_VERSION,
  capabilities: { repositoryIdentity: true },
  ...overrides,
});

const makeNetLayer = (occupied: boolean) =>
  Layer.succeed(
    NetService.NetService,
    NetService.NetService.of({
      canListenOnHost: () => Effect.succeed(!occupied),
      isPortAvailableOnLoopback: () => Effect.succeed(!occupied),
      hasListenerOnHost: () => Effect.succeed(occupied),
      reserveLoopbackPort: () => Effect.die("unexpected port reservation"),
      findAvailablePort: () => Effect.die("unexpected port scan"),
    }),
  );

type ProbeResponse =
  | { readonly _tag: "descriptor"; readonly value: unknown }
  | { readonly _tag: "status"; readonly status: number };

const makeHttpLayer = (probe: ProbeResponse) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          probe._tag === "descriptor"
            ? new Response(JSON.stringify(probe.value), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response(null, { status: probe.status }),
        ),
      ),
    ),
  );

const makeStateDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-discovery-"));

const writeRuntime = (
  stateDir: string,
  overrides: Partial<{
    readonly pid: number;
    readonly port: number;
    readonly origin: string;
  }> = {},
) => {
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "server-runtime.json"),
    `${JSON.stringify({
      version: 1,
      pid: process.pid,
      port: 49_731,
      origin: "http://127.0.0.1:49731",
      startedAt: "2026-09-04T00:00:00.000Z",
      ...overrides,
    })}\n`,
  );
};

const writeAttach = (
  stateDir: string,
  overrides: Partial<{
    readonly environmentId: string;
    readonly serverVersion: string;
    readonly credential: string;
  }> = {},
) => {
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "server-attach.json"),
    `${JSON.stringify({
      version: 1,
      environmentId: ENVIRONMENT_ID,
      serverVersion: DESKTOP_VERSION,
      credential: "fresh-attach-credential",
      createdAt: "2026-09-04T00:00:00.000Z",
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
};

const discover = (input: {
  readonly stateDir: string;
  readonly occupied: boolean;
  readonly probe?: ProbeResponse;
}) =>
  discoverDesktopBackend({ stateDir: input.stateDir, desktopVersion: DESKTOP_VERSION }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        makeNetLayer(input.occupied),
        makeHttpLayer(input.probe ?? { _tag: "descriptor", value: descriptor() }),
      ),
    ),
  );

describe("DesktopBackendDiscovery", () => {
  it.effect("attaches to a same-version owner on its recorded non-default port", () => {
    const stateDir = makeStateDir();
    writeRuntime(stateDir);
    writeAttach(stateDir);

    return Effect.gen(function* () {
      const result = yield* discover({ stateDir, occupied: true });
      assert.equal(result._tag, "Attach");
      if (result._tag !== "Attach") return;
      assert.equal(result.target.environmentId, ENVIRONMENT_ID);
      assert.equal(result.target.httpBaseUrl, "http://127.0.0.1:49731/");
      assert.equal(result.target.wsBaseUrl, "ws://127.0.0.1:49731/");
      assert.equal(result.target.credential, "fresh-attach-credential");
    });
  });

  const refusals: ReadonlyArray<{
    readonly name: string;
    readonly reason: DesktopBackendRefusalReason;
    readonly prepare: (stateDir: string) => ProbeResponse;
  }> = [
    {
      name: "environment ID mismatch",
      reason: "environment-id-mismatch",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        writeAttach(stateDir, { environmentId: "attach-file-other-environment" });
        return { _tag: "descriptor", value: descriptor() };
      },
    },
    {
      name: "foreign listener",
      reason: "foreign-listener",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        writeAttach(stateDir);
        return { _tag: "descriptor", value: { service: "not-t3" } };
      },
    },
    {
      name: "version mismatch",
      reason: "version-mismatch",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        writeAttach(stateDir);
        return { _tag: "descriptor", value: descriptor({ serverVersion: "0.0.36" }) };
      },
    },
    {
      name: "attach-file version mismatch",
      reason: "version-mismatch",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        writeAttach(stateDir, { serverVersion: "0.0.36" });
        return { _tag: "descriptor", value: descriptor() };
      },
    },
    {
      name: "missing attach file",
      reason: "attach-credential-unavailable",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        return { _tag: "descriptor", value: descriptor() };
      },
    },
    {
      name: "malformed attach file",
      reason: "attach-credential-unavailable",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        NodeFS.writeFileSync(NodePath.join(stateDir, "server-attach.json"), "{malformed");
        return { _tag: "descriptor", value: descriptor() };
      },
    },
    {
      name: "unreadable attach file",
      reason: "attach-credential-unavailable",
      prepare: (stateDir) => {
        writeRuntime(stateDir);
        NodeFS.mkdirSync(NodePath.join(stateDir, "server-attach.json"));
        return { _tag: "descriptor", value: descriptor() };
      },
    },
    ...([502, 503, 504] as const).map((status) => ({
      name: `live owner with ${String(status)} origin`,
      reason: "owner-origin-unreachable" as const,
      prepare: (stateDir: string) => {
        writeRuntime(stateDir);
        writeAttach(stateDir);
        return { _tag: "status" as const, status };
      },
    })),
  ];

  for (const refusal of refusals) {
    for (const occupied of [false, true]) {
      it.effect(`refuses ${refusal.name} when 3773 is ${occupied ? "occupied" : "free"}`, () => {
        const stateDir = makeStateDir();
        const probe = refusal.prepare(stateDir);
        return Effect.gen(function* () {
          const result = yield* discover({ stateDir, occupied, probe });
          assert.equal(result._tag, "Refuse");
          if (result._tag === "Refuse") assert.equal(result.error.reason, refusal.reason);
        });
      });
    }
  }

  const noOwnerStates: ReadonlyArray<{
    readonly name: string;
    readonly prepare: (stateDir: string) => void;
  }> = [
    { name: "absent runtime state", prepare: () => undefined },
    {
      name: "malformed runtime state",
      prepare: (stateDir) =>
        NodeFS.writeFileSync(NodePath.join(stateDir, "server-runtime.json"), "{malformed"),
    },
    {
      name: "dead recorded pid",
      prepare: (stateDir) => writeRuntime(stateDir, { pid: 4_194_305 }),
    },
  ];

  for (const state of noOwnerStates) {
    it.effect(`${state.name} spawns once on free 3773`, () => {
      const stateDir = makeStateDir();
      state.prepare(stateDir);
      return Effect.gen(function* () {
        const result = yield* discover({ stateDir, occupied: false });
        assert.deepEqual(result, { _tag: "Spawn", port: DEFAULT_DESKTOP_BACKEND_PORT });
      });
    });

    it.effect(`${state.name} refuses occupied 3773`, () => {
      const stateDir = makeStateDir();
      state.prepare(stateDir);
      return Effect.gen(function* () {
        const result = yield* discover({ stateDir, occupied: true });
        assert.equal(result._tag, "Refuse");
        if (result._tag === "Refuse") {
          assert.equal(result.error.reason, "default-port-occupied-without-owner");
        }
      });
    });
  }

  it("treats EPERM from signal 0 as a live owner", () => {
    assert.isTrue(
      isDesktopBackendProcessAlive(123, () => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }),
    );
  });
});
