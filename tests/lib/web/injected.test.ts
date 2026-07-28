/**
 * Every string this library injects into a page must at least be
 * JavaScript.
 *
 * Nothing else checks these. They are template literals, so the
 * compiler sees text, the linter sees text, and a stray bracket or
 * a helper renamed at one of two call sites reaches the browser
 * intact and fails there, at runtime, inside a probe whose failure
 * usually reads as "the page had nothing on it" rather than as a
 * syntax error.
 *
 * Compiling each one in Node is not the same as running it: the
 * globals differ, and nothing here executes. It catches the class
 * of mistake that actually happens when these are edited.
 */

import { describe, expect, it } from "vitest";
import { ANNOUNCEMENT_OBSERVER } from "../../../lib/web/a11y/announcements.js";
import { FOCUS_PROBE } from "../../../lib/web/a11y/focus.js";
import {
	WALK_COLLECT,
	WALK_READ,
	WALK_REMEMBER,
	WALK_RESTORE,
} from "../../../lib/web/a11y/walkprobe.js";
import {
	TARGET_CAPTURE,
	visualCaptureSource,
} from "../../../lib/web/audit/probe.js";
import { inventorySource } from "../../../lib/web/design/probe.js";
import { ANIMATIONS_PROBE } from "../../../lib/web/element/animations.js";
import {
	OCCLUDER_PROBE,
	SELECT_TEXT_PROBE,
} from "../../../lib/web/element/probes.js";
import { SETTLE_PROBE } from "../../../lib/web/element/pseudo.js";
import { ENVIRONMENT_PROBE } from "../../../lib/web/environment/probes.js";
import { evaluationSource } from "../../../lib/web/evaluate/probe.js";
import { DEEP_DOM } from "../../../lib/web/snapshot/deep.js";
import { PRESENTED } from "../../../lib/web/snapshot/presented.js";
import {
	COMPUTED_STYLE_PROBE,
	INITIALS_PROBE,
} from "../../../lib/web/styles/capture.js";
import { settleSource } from "../../../lib/web/wait/settle.js";

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
];

/**
 * Function bodies and declarations, which the protocol wraps
 * before evaluating. Compiled as a function rather than an
 * expression.
 */
const DECLARATIONS: ReadonlyArray<readonly [string, string]> = [
	["SELECT_TEXT_PROBE", SELECT_TEXT_PROBE],
	["OCCLUDER_PROBE", OCCLUDER_PROBE],
	["SETTLE_PROBE", SETTLE_PROBE],
	["ANIMATIONS_PROBE", ANIMATIONS_PROBE],
	["COMPUTED_STYLE_PROBE", COMPUTED_STYLE_PROBE],
	["INITIALS_PROBE", INITIALS_PROBE],
];

/**
 * Fragments that declare helpers for a host probe to use. They are
 * only valid inside one, so each is compiled in the same shape it
 * is used: wrapped in a block.
 */
const FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
	["DEEP_DOM", DEEP_DOM],
	["PRESENTED", PRESENTED],
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

	for (const [name, source] of FRAGMENTS) {
		it(`compiles ${name} the way a probe uses it`, () => {
			expect(() => new Function(`(() => { ${source} })`)).not.toThrow();
		});
	}

	for (const [name, source] of SCRIPTS) {
		it(`compiles ${name} as a script`, () => {
			expect(() => new Function(source)).not.toThrow();
		});
	}
});

describe("the two shared fragments declare what probes call", () => {
	// A probe that references a helper the fragment stopped
	// declaring fails only in the browser, so the contract between
	// them is asserted here instead.
	it("DEEP_DOM declares the traversal and the selector namer", () => {
		expect(DEEP_DOM).toContain("deepElements");
		expect(DEEP_DOM).toContain("deepSelectorFor");
	});

	it("PRESENTED declares each predicate a probe may ask for", () => {
		for (const helper of [
			"presented",
			"visible",
			"inertHere",
			"visuallyHidden",
		]) {
			expect(PRESENTED).toContain(`const ${helper} =`);
		}
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
