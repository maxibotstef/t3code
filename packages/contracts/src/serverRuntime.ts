import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

// Shared by the owner grant and Desktop discovery so an expired grant is never offered.
export const DESKTOP_ATTACH_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1_000;

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export const PersistedServerAttachCredential = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  serverVersion: Schema.String,
  credential: Schema.String,
  createdAt: Schema.String,
});
export type PersistedServerAttachCredential = typeof PersistedServerAttachCredential.Type;
