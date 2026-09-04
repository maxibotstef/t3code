import { assert, it } from "@effect/vitest";
import {
  FULL_WORKTREE_MATERIALIZATION_STATE,
  ThreadId,
  VcsWorktreeMaterializationState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ProjectionThreadRepositoryLive } from "../Layers/ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("048_ProjectionThreadMaterialization", (it) => {
  it.effect("adds explicit identity columns and a full-state backfill default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          linked_pull_request_json,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          pinned_at,
          pin_order_key,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'thread-pre-48',
          'project-pre-48',
          'Pre-48 thread',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          NULL,
          NULL,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          NULL
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{
        readonly name: string;
        readonly dfltValue: string | null;
        readonly notNull: number;
      }>`
        SELECT name, dflt_value AS "dfltValue", "notnull" AS "notNull"
        FROM pragma_table_info('projection_threads')
      `;
      for (const name of [
        "materialization_json",
        "materialization_requested_profile_id",
        "materialization_effective_profile_id",
        "materialization_mode",
        "materialization_expected_contract_sha256",
        "materialization_contract_sha256",
        "materialization_manifest_sha256",
        "materialization_reason",
      ]) {
        assert.ok(
          columns.some((column) => column.name === name),
          name,
        );
      }
      const defaultSql = columns.find(
        (column) => column.name === "materialization_json",
      )?.dfltValue;
      assert.ok(defaultSql);
      const defaultJson =
        defaultSql.startsWith("'") && defaultSql.endsWith("'")
          ? defaultSql.slice(1, -1).replaceAll("''", "'")
          : defaultSql;
      const decodedDefault = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(VcsWorktreeMaterializationState),
      )(defaultJson);
      assert.deepStrictEqual(decodedDefault, FULL_WORKTREE_MATERIALIZATION_STATE);

      const repository = yield* ProjectionThreadRepository;
      const row = yield* repository.getById({ threadId: ThreadId.make("thread-pre-48") });
      assert.ok(Option.isSome(row));
      assert.deepStrictEqual(row.value.materialization, FULL_WORKTREE_MATERIALIZATION_STATE);

      const materializationReason = columns.find(
        (column) => column.name === "materialization_reason",
      );
      assert.equal(materializationReason?.notNull, 0);
      const sparse = {
        ...FULL_WORKTREE_MATERIALIZATION_STATE,
        requestedProfileId: "governance-review",
        effectiveProfileId: "governance-review",
        mode: "sparse" as const,
        reason: null,
        expectedContractSha256: "a".repeat(64),
        contractSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        conePaths: ["docs"],
        requiredPaths: ["docs/spec.md"],
        taskId: "OC-1",
        taskSlug: "sparse-persistence",
        taskCardPath: "ops/stef-task/sparse-persistence/stef-task.json",
        scopePaths: ["docs/spec.md"],
      };
      yield* repository.upsert({
        ...row.value,
        materialization: sparse,
        updatedAt: "2026-09-01T00:00:01.000Z",
      });
      const sparseRow = yield* repository.getById({
        threadId: ThreadId.make("thread-pre-48"),
      });
      assert.ok(Option.isSome(sparseRow));
      assert.deepStrictEqual(sparseRow.value.materialization, sparse);
      const rawReason = yield* sql<{ readonly reason: string | null }>`
        SELECT materialization_reason AS reason
        FROM projection_threads
        WHERE thread_id = 'thread-pre-48'
      `;
      assert.deepStrictEqual(rawReason, [{ reason: null }]);
    }),
  );
});
