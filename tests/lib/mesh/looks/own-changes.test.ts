import { describe, expect, it } from "vitest";
import {
	opensOneOf,
	proposedIn,
} from "../../../../lib/mesh/looks/own-changes.ts";

const PR = "https://github.com/Jitsusama/agentic-harness.pi/pull/12";

/** A tool's answer as a session's log keeps it. */
function answered(toolName: string, details: unknown): unknown {
	return {
		type: "message",
		message: { role: "toolResult", toolName, details },
	};
}

// Joel, 24 November: "don't fucking put prs in my look list, review it
// your fucking self".
describe("a session's own changes", () => {
	it("reads what review_offer proposed, one or a stack, and nothing else", () => {
		const entries = [
			answered("review_offer", { ok: true, change: "#12", url: PR }),
			answered("review_offer", {
				ok: true,
				urls: [`${PR}3`, 7, ""],
			}),
			answered("review_see", { url: "https://github.com/o/r/pull/9" }),
			{ type: "message", message: { role: "user", content: PR } },
			"torn",
		];

		expect(proposedIn(entries)).toEqual([PR, `${PR}3`]);
	});

	it("finds a change by its tabs, diffs and comments, not by a longer number", () => {
		expect(opensOneOf(PR, [PR])).toBe(true);
		expect(opensOneOf(`${PR}/files`, [PR])).toBe(true);
		expect(opensOneOf(`${PR}#discussion_r1`, [`${PR}/`])).toBe(true);
		expect(opensOneOf(`${PR}?w=1`, [PR])).toBe(true);
		expect(opensOneOf(`${PR}3`, [PR])).toBe(false);
		expect(opensOneOf(PR, [])).toBe(false);
		expect(opensOneOf(PR, [""])).toBe(false);
	});
});
