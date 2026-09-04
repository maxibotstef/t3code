import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has("materialization_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_json TEXT NOT NULL DEFAULT '{"status":"ready","requestedProfileId":"full","effectiveProfileId":"full","mode":"full","reason":"default-full","expectedContractSha256":null,"contractSha256":null,"manifestSha256":null,"conePaths":[],"requiredPaths":[],"taskId":null,"taskSlug":null,"taskCardPath":null,"baseSha":null}'
    `;
  }
  if (!has("materialization_requested_profile_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_requested_profile_id TEXT NOT NULL DEFAULT 'full'
    `;
  }
  if (!has("materialization_effective_profile_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_effective_profile_id TEXT NOT NULL DEFAULT 'full'
    `;
  }
  if (!has("materialization_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_mode TEXT NOT NULL DEFAULT 'full'
    `;
  }
  if (!has("materialization_expected_contract_sha256")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_expected_contract_sha256 TEXT
    `;
  }
  if (!has("materialization_contract_sha256")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_contract_sha256 TEXT
    `;
  }
  if (!has("materialization_manifest_sha256")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_manifest_sha256 TEXT
    `;
  }
  if (!has("materialization_reason")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN materialization_reason TEXT DEFAULT 'default-full'
    `;
  }
});
