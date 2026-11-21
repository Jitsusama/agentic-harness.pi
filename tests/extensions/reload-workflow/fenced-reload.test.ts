/**
 * A fenced session's model may not reload onto a tree: the reload runs
 * the tree's code in this pi, outside the fence, and a fenced command
 * may have written it. Back onto the install it may always go.
 */

import { describe, expect, it } from "vitest";
import { fencedReloadRefusal } from "../../../extensions/reload-workflow/transitions.ts";

describe("a reload asked for by a fenced session's model", () => {
	it("is refused onto a tree, saying the way back", () => {
		const said = fencedReloadRefusal("/w/tree", "fence");
		expect(said).toContain("outside it");
		expect(said).toContain('Reload onto "installed"');
	});

	it("is refused in the strict sandbox too", () => {
		expect(fencedReloadRefusal("/w/tree", "strict")).toContain(
			"strict sandbox",
		);
	});

	it("goes ahead onto the install", () => {
		expect(fencedReloadRefusal(undefined, "fence")).toBeUndefined();
	});

	it("goes ahead onto a tree in an unfenced session", () => {
		expect(fencedReloadRefusal("/w/tree", undefined)).toBeUndefined();
	});
});
