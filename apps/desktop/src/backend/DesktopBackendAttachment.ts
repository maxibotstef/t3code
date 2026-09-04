import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { DesktopBackendAttachTarget } from "./DesktopBackendDiscovery.ts";

export interface DesktopBackendAttachmentState {
  readonly target: DesktopBackendAttachTarget;
  readonly ready: boolean;
}

interface DesktopBackendAttachmentService {
  readonly current: Effect.Effect<Option.Option<DesktopBackendAttachmentState>>;
  readonly setReady: (target: DesktopBackendAttachTarget) => Effect.Effect<void>;
  readonly markUnready: (expectedEnvironmentId: string) => Effect.Effect<void>;
}

const unavailableAttachmentService: DesktopBackendAttachmentService = {
  current: Effect.succeed(Option.none()),
  setReady: () => Effect.void,
  markUnready: () => Effect.void,
};

export class DesktopBackendAttachment extends Context.Reference<DesktopBackendAttachmentService>(
  "@t3tools/desktop/backend/DesktopBackendAttachment",
  { defaultValue: () => unavailableAttachmentService },
) {}

export const layer = Layer.effect(
  DesktopBackendAttachment,
  Effect.gen(function* () {
    const state = yield* Ref.make<Option.Option<DesktopBackendAttachmentState>>(Option.none());
    return {
      current: Ref.get(state),
      setReady: (target) => Ref.set(state, Option.some({ target, ready: true })),
      markUnready: (expectedEnvironmentId) =>
        Ref.update(
          state,
          Option.map((current) =>
            current.target.environmentId === expectedEnvironmentId
              ? { ...current, ready: false }
              : current,
          ),
        ),
    } satisfies DesktopBackendAttachmentService;
  }),
);
