import type { ToolContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isPersistedSession } from "../../../extensions/quest-workflow/verbs/shared";

const ctx = (sessionManager: unknown): ToolContext =>
	({ sessionManager }) as unknown as ToolContext;

describe("isPersistedSession", () => {
	it("is true when the accessor reports a persisted session", () => {
		expect(isPersistedSession(ctx({ isPersisted: () => true }))).toBe(true);
	});

	it("is false when the accessor reports an ephemeral session", () => {
		expect(isPersistedSession(ctx({ isPersisted: () => false }))).toBe(false);
	});

	it("defaults to true when the accessor is absent", () => {
		expect(isPersistedSession(ctx({}))).toBe(true);
		expect(isPersistedSession(ctx(undefined))).toBe(true);
	});

	it("defaults to true when the accessor throws", () => {
		expect(
			isPersistedSession(
				ctx({
					isPersisted: () => {
						throw new Error("probe failed");
					},
				}),
			),
		).toBe(true);
	});
});
