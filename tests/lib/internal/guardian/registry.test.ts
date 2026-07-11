import { beforeEach, describe, expect, it } from "vitest";
import {
	clear,
	list,
	record,
	register,
} from "../../../../lib/internal/guardian/registry.js";

beforeEach(() => clear());

describe("guardian registry", () => {
	it("records an outcome with a timestamp and surfaces it in list", () => {
		record("commit", { kind: "blocked", reason: "bad prose" });
		const [entry] = list();
		expect(entry.name).toBe("commit");
		expect(entry.lastOutcome).toEqual({ kind: "blocked", reason: "bad prose" });
		expect(entry.lastCalledAt).toBeInstanceOf(Date);
	});

	it("seeds an entry with no outcome, and re-registering preserves it", () => {
		register("pr");
		expect(list()[0]).toEqual({ name: "pr" });

		record("pr", { kind: "allowed" });
		register("pr"); // idempotent: must not wipe the recorded outcome
		expect(list()[0].lastOutcome).toEqual({ kind: "allowed" });
	});

	it("returns entries sorted by name regardless of insertion order", () => {
		register("zebra");
		register("alpha");
		expect(list().map((e) => e.name)).toEqual(["alpha", "zebra"]);
	});

	it("returns a snapshot that does not mutate the registry", () => {
		record("commit", { kind: "allowed" });
		const snapshot = list();
		snapshot[0].name = "tampered";
		expect(list()[0].name).toBe("commit");
	});
});
