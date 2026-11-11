/**
 * Every string this library injects into a page must at least be
 * JavaScript.
 *
 * Most live in `.page.js` files the linter reads, and the rest are
 * template literals it sees as text. Either way nothing runs them
 * before a browser does, so a stray bracket, or a helper renamed
 * where it is given but not where it is taken, fails there, at
 * runtime, inside a probe whose failure usually reads as "the page
 * had nothing on it" rather than as a syntax error.
 *
 * Compiling each one in Node is not the same as running it: the
 * globals differ, and nothing here executes. It catches the class
 * of mistake that actually happens when these are edited.
 */

import { describe, expect, it } from "vitest";
import { ANNOUNCEMENT_OBSERVER } from "../../../lib/core/web/a11y/announcements.ts";
import { FOCUS_PROBE } from "../../../lib/core/web/a11y/focus.ts";
import {
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
} from "../../../lib/core/web/a11y/walkprobe.ts";
import {
	TARGET_CAPTURE,
	visualCaptureSource,
} from "../../../lib/core/web/audit/probe.ts";
import { inventorySource } from "../../../lib/core/web/design/probe.ts";
import { ANIMATIONS_PROBE } from "../../../lib/core/web/element/animations.ts";
import {
	OCCLUDER_PROBE,
	OWN_TEXT_PROBE,
	PAINTING_ELEMENT_PROBE,
	SELECT_TEXT_PROBE,
} from "../../../lib/core/web/element/probes.ts";
import { SETTLE_PROBE } from "../../../lib/core/web/element/pseudo.ts";
import { ENVIRONMENT_PROBE } from "../../../lib/core/web/environment/probes.ts";
import { evaluationSource } from "../../../lib/core/web/evaluate/probe.ts";
import { DEEP_DOM } from "../../../lib/core/web/snapshot/deep.ts";
import { PRESENTED } from "../../../lib/core/web/snapshot/presented.ts";
import {
	COMPUTED_STYLE_PROBE,
	INITIALS_PROBE,
} from "../../../lib/core/web/styles/capture.ts";
import { settleSource } from "../../../lib/core/web/wait/settle.ts";

/**
 * Whole expressions, injected as they stand. Each must parse as an
 * expression, since that is how the protocol evaluates them.
 */
const EXPRESSIONS: ReadonlyArray<readonly [string, string]> = [
	["TARGET_CAPTURE", TARGET_CAPTURE],
	["visualCaptureSource()", visualCaptureSource()],
	["inventorySource()", inventorySource()],
	["settleSource()", settleSource()],
	["WALK_COLLECT", WALK_COLLECT],
	["WALK_READ", WALK_READ],
	["WALK_REMEMBER", WALK_REMEMBER],
	["WALK_RESTORE", WALK_RESTORE],
	["ENVIRONMENT_PROBE", ENVIRONMENT_PROBE],
	["FOCUS_PROBE", FOCUS_PROBE],
	["evaluationSource(1 + 1)", evaluationSource("1 + 1")],
	["DEEP_DOM", DEEP_DOM],
	["PRESENTED", PRESENTED],
];

/**
 * Function bodies and declarations, which the protocol wraps
 * before evaluating. Compiled as a function rather than an
 * expression.
 */
const DECLARATIONS: ReadonlyArray<readonly [string, string]> = [
	["SELECT_TEXT_PROBE", SELECT_TEXT_PROBE],
	["OCCLUDER_PROBE", OCCLUDER_PROBE],
	["OWN_TEXT_PROBE", OWN_TEXT_PROBE],
	["PAINTING_ELEMENT_PROBE", PAINTING_ELEMENT_PROBE],
	["SETTLE_PROBE", SETTLE_PROBE],
	["ANIMATIONS_PROBE", ANIMATIONS_PROBE],
	["COMPUTED_STYLE_PROBE", COMPUTED_STYLE_PROBE],
	["INITIALS_PROBE", INITIALS_PROBE],
];

/**
 * Whole scripts, installed rather than evaluated for a value.
 * These run before any document, so they are statements and must
 * not be wrapped as an expression.
 */
const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
	["ANNOUNCEMENT_OBSERVER", ANNOUNCEMENT_OBSERVER],
];

describe("injected page source is at least JavaScript", () => {
	for (const [name, source] of EXPRESSIONS) {
		it(`compiles ${name} as an expression`, () => {
			expect(() => new Function(`return (${source});`)).not.toThrow();
		});
	}

	for (const [name, source] of DECLARATIONS) {
		it(`compiles ${name}`, () => {
			expect(() => new Function(`return (${source});`)).not.toThrow();
		});
	}

	for (const [name, source] of SCRIPTS) {
		it(`compiles ${name} as a script`, () => {
			expect(() => new Function(source)).not.toThrow();
		});
	}
});

/**
 * The names a helper script gives a probe, read by evaluating it. Each
 * only defines functions, so evaluating one touches no page.
 */
function given(source: string): string[] {
	const helpers: unknown = new Function(`return (${source});`)();
	return Object.keys(helpers as object).sort();
}

describe("the two shared helper scripts give what probes take", () => {
	// A probe that takes a helper the script stopped giving fails
	// only in the browser, so the contract between them is asserted
	// here instead.
	it("DEEP_DOM gives the traversal and the selector namer", () => {
		expect(given(DEEP_DOM)).toEqual(["deepElements", "deepSelectorFor"]);
	});

	it("PRESENTED gives each predicate a probe may ask for", () => {
		expect(given(PRESENTED)).toEqual([
			"inertHere",
			"presented",
			"visible",
			"visuallyHidden",
		]);
	});

	it("every probe that calls presented also injects PRESENTED", () => {
		// The failure this prevents is silent: an undeclared helper
		// throws inside the page and the capture comes back empty,
		// which reads as a page with nothing on it.
		for (const [name, source] of [
			["TARGET_CAPTURE", TARGET_CAPTURE],
			["visualCaptureSource()", visualCaptureSource()],
			["inventorySource()", inventorySource()],
		] as const) {
			if (!source.includes("presented(") && !source.includes("visible(")) {
				continue;
			}
			expect(source, `${name} calls a PRESENTED helper`).toContain(
				"const presented =",
			);
		}
	});

	it("every probe that walks deeply also injects DEEP_DOM", () => {
		for (const [name, source] of EXPRESSIONS) {
			if (!source.includes("deepElements(")) continue;
			expect(source, `${name} calls deepElements`).toContain(
				"const deepElements",
			);
		}
	});
});
