import { assert, describe, it } from "@effect/vitest";

import { DesktopDevelopmentBackendPortRequiredError } from "./DesktopApp.ts";

describe("DesktopApp errors", () => {
  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "T3CODE_PORT is required in desktop development.");
  });
});
