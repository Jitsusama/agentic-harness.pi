/**
 * A fenced session's model may not reload onto a tree: the reload runs
 * the tree's code in this pi, outside the fence, and a fenced command
 * may have written it. Back onto the install it may go while pi's
 * settings name the install.
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
		expect(
			fencedReloadRefusal(
				undefined,
				"fence",
				() => "/h/.local/share/pi-packages/harness/versions/a",
				() => "/h/.local/share/pi-packages",
			),
		).toBeUndefined();
	});

	it("is refused onto the install while pi's settings still name a tree, which a reload onto it left", () => {
		const said = fencedReloadRefusal(
			undefined,
			"fence",
			() => "/w/tree",
			() => "/h/.local/share/pi-packages",
		);
		expect(said).toContain("/w/tree");
		expect(said).toContain("Point the settings' entry back at the install");
	});

	it("is refused onto the install while pi's settings name no harness", () => {
		expect(
			fencedReloadRefusal(
				undefined,
				"strict",
				() => undefined,
				() => "/h/.local/share/pi-packages",
			),
		).toContain("from nowhere");
	});

	it("goes ahead onto the install in an unfenced session, whatever the settings name", () => {
		expect(
			fencedReloadRefusal(undefined, undefined, () => "/w/tree"),
		).toBeUndefined();
	});

	it("goes ahead onto a tree in an unfenced session", () => {
		expect(fencedReloadRefusal("/w/tree", undefined)).toBeUndefined();
	});
});
