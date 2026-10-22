/**
 * `work record` wraps a body rather than refusing it for its width.
 *
 * Body lines a few characters past 72 were refused one at a time, twenty
 * times since 12 October, for a change that takes no judgement. The width
 * has one right form, so the tool gives it that form and says so; the
 * subject, which does take judgement, is still the caller's to fix.
 */

import { complaintsAbout } from "@jitsusama/agentic-harness.core/guardian/commit-format";
import { describe, expect, it } from "vitest";
import { recordMessage } from "../../extensions/work-integration/tools/message.ts";

const LONG =
	"A body line that runs a little past the seventy-two column limit for no reason.";

describe("the message work record commits", () => {
	it("wraps a body line past 72 so the format holds", () => {
		const message = recordMessage("fix(work): wrap it", LONG);

		expect(message.wrapped).toBe(true);
		expect(complaintsAbout(message.proposed)).toEqual([]);
		expect(message.body?.split("\n").every((line) => line.length <= 72)).toBe(
			true,
		);
	});

	it("leaves a body that already fits exactly as written", () => {
		const body = "Short enough.\n\n- one\n- two";
		const message = recordMessage("fix(work): wrap it", body);

		expect(message.wrapped).toBe(false);
		expect(message.body).toBe(body);
	});

	it("still refuses a subject past its limit, which wrapping cannot fix", () => {
		const message = recordMessage(`fix(work): ${"x".repeat(60)}`, LONG);

		expect(complaintsAbout(message.proposed).length).toBeGreaterThan(0);
	});

	it("carries no body when none was given", () => {
		const message = recordMessage("fix(work): wrap it", undefined);

		expect(message.body).toBeUndefined();
		expect(message.proposed).toBe("fix(work): wrap it");
	});
});
