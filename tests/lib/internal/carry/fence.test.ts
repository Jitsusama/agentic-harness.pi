/**
 * The fence a session carries: read from its `PI_SANDBOX`, and named in
 * a done file only as a harness names it.
 */

import { describe, expect, it } from "vitest";
import {
	fenceKindOf,
	isFenceKind,
	sandboxAsking,
} from "../../../../lib/internal/carry/fence.ts";

describe("a carried session's fence", () => {
	it("is what its PI_SANDBOX asks for", () => {
		expect(fenceKindOf({ PI_SANDBOX: "strict" })).toBe("strict");
		expect(fenceKindOf({ PI_SANDBOX: "fence" })).toBe("fence");
		expect(fenceKindOf({ PI_SANDBOX: "off" })).toBe("none");
	});

	it("starts again under what PI_SANDBOX asks for it, off for none", () => {
		expect(sandboxAsking("fence")).toBe("fence");
		expect(sandboxAsking("strict")).toBe("strict");
		expect(sandboxAsking("none"), "none would read as the fence").toBe("off");
		for (const kind of ["none", "fence", "strict"] as const) {
			expect(fenceKindOf({ PI_SANDBOX: sandboxAsking(kind) })).toBe(kind);
		}
	});

	it("is named only as a harness names it", () => {
		expect(["none", "fence", "strict"].filter(isFenceKind)).toHaveLength(3);
		expect(isFenceKind("loose"), "a stray word").toBe(false);
		expect(isFenceKind(undefined), "nothing at all").toBe(false);
	});
});
