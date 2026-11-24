import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	keepProposed,
	keptProposed,
	MOST_KEPT,
	opensOneOf,
	ownChangesBeside,
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

	it("finds a change however its URL is spelled", () => {
		const spelled = [
			`${PR}.diff`,
			`${PR}.patch`,
			"https://github.com/jitsusama/Agentic-Harness.pi/pull/12",
			"http://github.com/Jitsusama/agentic-harness.pi/pull/12",
			"https://www.github.com/Jitsusama/agentic-harness.pi/pull/12/files",
			` ${PR}/ `,
		];
		for (const target of spelled) expect(opensOneOf(target, [PR])).toBe(true);
		expect(opensOneOf(`${PR}3.diff`, [PR])).toBe(false);
		expect(opensOneOf(PR, [`${PR}.diff`])).toBe(true);
	});
});

describe("the record of what a quest proposed", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
	});

	/** A folder of looks, in a folder of its own, to keep the record beside. */
	function records(): string {
		const top = mkdtempSync(join(tmpdir(), "own-changes-"));
		made.push(top);
		return ownChangesBeside(join(top, "looks"));
	}

	it("keeps each owner's proposals, once each, past the session that made them", () => {
		const dir = records();
		keepProposed(dir, "QEST-1", [PR]);
		keepProposed(dir, "QEST-1", [`${PR}/`, `${PR}3`]);
		keepProposed(dir, "0193-session", ["https://github.com/o/r/pull/9"]);

		expect(keptProposed(dir, ["QEST-1"])).toEqual([PR, `${PR}3`]);
		expect(keptProposed(dir, [undefined, "0193-session"])).toEqual([
			"https://github.com/o/r/pull/9",
		]);
		expect(keptProposed(dir, ["QEST-2", ""])).toEqual([]);
	});

	it("keeps the newest, and an owner's id never names a file outside the folder", () => {
		const dir = records();
		const many = Array.from(
			{ length: MOST_KEPT + 5 },
			(_, at) => `https://github.com/o/r/pull/${at}`,
		);
		keepProposed(dir, "../away", many);

		const kept = keptProposed(dir, ["../away"]);
		expect(kept).toHaveLength(MOST_KEPT);
		expect(kept.at(-1)).toBe(many.at(-1));
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([
			"___away.json",
		]);
	});

	it("reads a torn record as nothing, and the next proposal rewrites it", () => {
		const dir = records();
		keepProposed(dir, "QEST-1", [PR]);
		writeFileSync(join(dir, "QEST-1.json"), "{torn");
		expect(keptProposed(dir, ["QEST-1"])).toEqual([]);

		keepProposed(dir, "QEST-1", [`${PR}3`]);
		expect(keptProposed(dir, ["QEST-1"])).toEqual([`${PR}3`]);
	});
});
