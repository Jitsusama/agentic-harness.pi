import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isPersistedSession } from "../../../extensions/quest-workflow/verbs/shared";

const ctx = (sessionManager: unknown): ExtensionContext =>
	({ sessionManager }) as unknown as ExtensionContext;

describe("isPersistedSession", () => {
	it("is true when the accessor reports a persisted session", () => {
		expect(
			isPersistedSession(ctx({ isPersisted: () => true })),
			"an accessor reporting persisted reads as persisted",
		).toBe(true);
	});

	it("is false when the accessor reports an ephemeral session", () => {
		expect(
			isPersistedSession(ctx({ isPersisted: () => false })),
			"an accessor reporting ephemeral reads as ephemeral",
		).toBe(false);
	});

	it("defaults to true when the accessor is absent", () => {
		expect(
			isPersistedSession(ctx({})),
			"a session manager without the accessor reads as persisted",
		).toBe(true);
		expect(
			isPersistedSession(ctx(undefined)),
			"no session manager at all reads as persisted",
		).toBe(true);
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
			"an accessor that throws reads as persisted",
		).toBe(true);
	});
});
