import {
  ExecutionEnvironmentDescriptor,
  PersistedServerAttachCredential,
  PersistedServerRuntimeState,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorValue,
  type PersistedServerAttachCredential as PersistedServerAttachCredentialValue,
  type PersistedServerRuntimeState as PersistedServerRuntimeStateValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const DEFAULT_DESKTOP_BACKEND_PORT = 3773;
export const DESKTOP_BACKEND_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const DESKTOP_OWNER_PROBE_TIMEOUT = Duration.millis(2_500);

export const DesktopBackendRefusalReason = Schema.Literals([
  "foreign-listener",
  "environment-id-mismatch",
  "version-mismatch",
  "attach-credential-unavailable",
  "owner-origin-unreachable",
  "default-port-occupied-without-owner",
]);
export type DesktopBackendRefusalReason = typeof DesktopBackendRefusalReason.Type;

export class DesktopBackendDiscoveryRefusedError extends Schema.TaggedErrorClass<DesktopBackendDiscoveryRefusedError>()(
  "DesktopBackendDiscoveryRefusedError",
  {
    reason: DesktopBackendRefusalReason,
    origin: Schema.optional(Schema.String),
    expectedEnvironmentId: Schema.optional(Schema.String),
    actualEnvironmentId: Schema.optional(Schema.String),
    desktopVersion: Schema.optional(Schema.String),
    serverVersion: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "foreign-listener":
        return `A live process owns this T3 home, but ${this.origin ?? "its recorded origin"} is not a T3 Code server.`;
      case "environment-id-mismatch":
        return `The live T3 Code owner environment ID (${this.actualEnvironmentId ?? "unknown"}) does not match server-attach.json (${this.expectedEnvironmentId ?? "unknown"}).`;
      case "version-mismatch":
        return `The live T3 Code owner version (${this.serverVersion ?? "unknown"}) does not exactly match this Desktop version (${this.desktopVersion ?? "unknown"}).`;
      case "attach-credential-unavailable":
        return "The live T3 Code owner predates Desktop attach or its server-attach.json is missing, unreadable, or malformed.";
      case "owner-origin-unreachable":
        return `A live process owns this T3 home, but its recorded origin ${this.origin ?? "is unknown"} is unreachable.`;
      case "default-port-occupied-without-owner":
        return `Desktop cannot start a backend because port ${String(DEFAULT_DESKTOP_BACKEND_PORT)} is occupied and no live owner was discovered for this T3 home.`;
    }
  }
}

export interface DesktopBackendAttachTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
  readonly runtimeState: PersistedServerRuntimeStateValue;
  readonly attachCredential: PersistedServerAttachCredentialValue;
  readonly descriptor: ExecutionEnvironmentDescriptorValue;
}

export type DesktopBackendDiscoveryResult =
  | { readonly _tag: "Attach"; readonly target: DesktopBackendAttachTarget }
  | { readonly _tag: "Spawn"; readonly port: typeof DEFAULT_DESKTOP_BACKEND_PORT }
  | { readonly _tag: "Refuse"; readonly error: DesktopBackendDiscoveryRefusedError };

type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptorValue }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

const decodeRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const decodeAttachCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerAttachCredential),
);

const readOptionalJson = <A, I, R>(
  filePath: string,
  decode: (input: string) => Effect.Effect<A, I, R>,
): Effect.Effect<Option.Option<A>, never, FileSystem.FileSystem | R> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(filePath);
    if (raw.trim().length === 0) return Option.none<A>();
    return Option.some(yield* decode(raw.trim()));
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const toWebSocketBaseUrl = (origin: string): string => {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const descriptorUrl = yield* Effect.try({
      try: () => new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString(),
      catch: () => ({ _tag: "unreachable" }) as const,
    });
    const request = HttpClientRequest.get(descriptorUrl);
    const response = yield* client.execute(request).pipe(
      Effect.timeout(DESKTOP_OWNER_PROBE_TIMEOUT),
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

type ProcessSignalProbe = (pid: number, signal: 0) => unknown;

export const isDesktopBackendProcessAlive = (
  pid: number,
  signalProcess: ProcessSignalProbe = process.kill.bind(process),
): boolean => {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return (
      Predicate.isObject(error) && Predicate.hasProperty(error, "code") && error.code === "EPERM"
    );
  }
};

const isDefaultDesktopPortAvailable = Effect.fn("desktop.backendDiscovery.defaultPortAvailable")(
  function* () {
    const net = yield* NetService.NetService;
    for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(DEFAULT_DESKTOP_BACKEND_PORT, host))) return false;
    }
    return true;
  },
);

const classifyNoLiveOwner = isDefaultDesktopPortAvailable().pipe(
  Effect.map(
    (available): DesktopBackendDiscoveryResult =>
      available
        ? { _tag: "Spawn", port: DEFAULT_DESKTOP_BACKEND_PORT }
        : {
            _tag: "Refuse",
            error: new DesktopBackendDiscoveryRefusedError({
              reason: "default-port-occupied-without-owner",
            }),
          },
  ),
);

export const discoverDesktopBackend = Effect.fn("desktop.backendDiscovery.discover")(
  function* (input: {
    readonly stateDir: string;
    readonly desktopVersion: string;
  }): Effect.fn.Return<
    DesktopBackendDiscoveryResult,
    never,
    FileSystem.FileSystem | HttpClient.HttpClient | NetService.NetService | Path.Path
  > {
    const path = yield* Path.Path;
    const runtimeState = yield* readOptionalJson(
      path.join(input.stateDir, "server-runtime.json"),
      decodeRuntimeState,
    );
    if (Option.isNone(runtimeState) || !isDesktopBackendProcessAlive(runtimeState.value.pid)) {
      return yield* classifyNoLiveOwner;
    }

    const probed = yield* probeEnvironmentDescriptor(runtimeState.value.origin);
    if (probed._tag === "unreachable") {
      return {
        _tag: "Refuse",
        error: new DesktopBackendDiscoveryRefusedError({
          reason: "owner-origin-unreachable",
          origin: runtimeState.value.origin,
        }),
      };
    }
    if (probed._tag === "not-a-t3-server") {
      return {
        _tag: "Refuse",
        error: new DesktopBackendDiscoveryRefusedError({
          reason: "foreign-listener",
          origin: runtimeState.value.origin,
        }),
      };
    }

    const attachCredential = yield* readOptionalJson(
      path.join(input.stateDir, "server-attach.json"),
      decodeAttachCredential,
    );
    if (Option.isNone(attachCredential)) {
      return {
        _tag: "Refuse",
        error: new DesktopBackendDiscoveryRefusedError({
          reason: "attach-credential-unavailable",
          origin: runtimeState.value.origin,
        }),
      };
    }
    if (probed.descriptor.environmentId !== attachCredential.value.environmentId) {
      return {
        _tag: "Refuse",
        error: new DesktopBackendDiscoveryRefusedError({
          reason: "environment-id-mismatch",
          expectedEnvironmentId: attachCredential.value.environmentId,
          actualEnvironmentId: probed.descriptor.environmentId,
        }),
      };
    }
    if (
      probed.descriptor.serverVersion !== input.desktopVersion ||
      attachCredential.value.serverVersion !== input.desktopVersion
    ) {
      const mismatchedVersion =
        probed.descriptor.serverVersion !== input.desktopVersion
          ? probed.descriptor.serverVersion
          : attachCredential.value.serverVersion;
      return {
        _tag: "Refuse",
        error: new DesktopBackendDiscoveryRefusedError({
          reason: "version-mismatch",
          desktopVersion: input.desktopVersion,
          serverVersion: mismatchedVersion,
        }),
      };
    }

    return {
      _tag: "Attach",
      target: {
        environmentId: probed.descriptor.environmentId,
        label: probed.descriptor.label,
        httpBaseUrl: runtimeState.value.origin,
        wsBaseUrl: toWebSocketBaseUrl(runtimeState.value.origin),
        credential: attachCredential.value.credential,
        runtimeState: runtimeState.value,
        attachCredential: attachCredential.value,
        descriptor: probed.descriptor,
      },
    };
  },
);
