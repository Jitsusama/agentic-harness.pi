/**
 * Heavy calls: how a sentence names the heavy work a lease claims.
 */
import { describe, expect, it } from "vitest";
import { heavySaid } from "../../../../extensions/mesh-workflow/leases/heavy-calls.ts";

describe("heavySaid", () => {
	it("names a kind the queue knows in the queue's words", () => {
		expect(heavySaid("build")).toBe("a build");
	});

	// A holder writes its subject as it likes, so one naming a key every
	// object inherits is no kind, and is said as itself (#2243's fourth
	// council, F11).
	it("names a subject that only an object's prototype holds as itself", () => {
		expect(heavySaid("constructor")).toBe("heavy work on constructor");
		expect(heavySaid("toString")).toBe("heavy work on toString");
	});
});
