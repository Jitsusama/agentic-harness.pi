/**
 * The commit subject's limit, said where the subject is written.
 *
 * Core's commit format refuses a subject past its limit, and for a
 * while the refusal was the only place the number was said, so subjects
 * were written to a guess and refused for a character or three. The
 * work tool's subject parameter now names the limit, and this holds it
 * to the one core enforces.
 */

import { validate } from "@jitsusama/agentic-harness.core/guardian/commit-format";
import { describe, expect, it } from "vitest";
import workIntegration from "../../extensions/work-integration/index.ts";
import { SUBJECT_LIMIT } from "../../extensions/work-integration/tools/tree.ts";
import { activateWith, toolNamed } from "./support/review-extension.ts";

/** A conventional subject of exactly this many characters. */
function subjectOf(length: number): string {
	const prefix = "fix(work): ";
	return prefix + "a".repeat(length - prefix.length);
}

describe("the commit subject's limit", () => {
	it("is the one core's commit format enforces", () => {
		expect(validate(subjectOf(SUBJECT_LIMIT)).subjectOk).toBe(true);
		expect(validate(subjectOf(SUBJECT_LIMIT + 1)).subjectOk).toBe(false);
	});

	it("is said in the subject's description, with a shorter length to aim for", () => {
		const work = toolNamed(activateWith(workIntegration), "work");

		expect(work.parameters).toMatchObject({
			properties: {
				subject: {
					description: expect.stringContaining(
						`At most ${SUBJECT_LIMIT} characters, type and scope included; aim for about 40`,
					),
				},
			},
		});
	});
});
