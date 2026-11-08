import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksIn, pointAt } from "../../../lib/mesh/looks.ts";
import {
	ASK_EVERY_MS,
	askable,
	markResolved,
	pullOf,
	queryFor,
	resolutionsFrom,
	takeTurnToAsk,
} from "../../../lib/mesh/looks-github.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "looks-gh-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PR = "https://github.com/Jitsusama/core.nix/pull/2386";
const who = { session: "S1" };
const look = (target: string, title: string) =>
	pointAt(dir, { kind: "pr", target, title, why: "For you to see." }, who);

// Joel, 8 November: "i shouldn't be required to mark a notice as read if
// I looked at the slack message in slack for example."
describe("asking GitHub about the person's looks", () => {
	it("reads a pull request from its URL, its tabs included, and nothing else", () => {
		expect(pullOf(`${PR}/files`)).toEqual({
			owner: "Jitsusama",
			repo: "core.nix",
			number: 2386,
		});
		expect(
			pullOf("https://github.com/Jitsusama/core.nix/issues/5"),
		).toBeUndefined();
		expect(pullOf("https://example.com/pull/5")).toBeUndefined();
	});

	it("asks only about waiting looks at pull requests, in one query", () => {
		look(PR, "Agent sources");
		pointAt(dir, { kind: "file", target: "/x", title: "x", why: "y" }, who);
		const asked = askable(looksIn(dir));

		expect(asked.map((one) => one.pull.number)).toEqual([2386]);
		expect(queryFor(asked.map((one) => one.pull))).toMatch(
			/viewer \{ login \} p0: repository\(owner: "Jitsusama", name: "core.nix"\) \{ pullRequest\(number: 2386\)/,
		);
	});

	it("resolves what merged, closed or got the person's own review, and leaves the rest", () => {
		const asked = [
			{ id: "a" },
			{ id: "b" },
			{ id: "c" },
			{ id: "d" },
			{ id: "e" },
		];
		const reviews = (...logins: string[]) => ({
			nodes: logins.map((login) => ({ author: { login } })),
		});
		const answer = {
			data: {
				viewer: { login: "Jitsusama" },
				p0: { pullRequest: { state: "MERGED", reviews: reviews() } },
				p1: { pullRequest: { state: "CLOSED", reviews: reviews() } },
				p2: {
					pullRequest: {
						state: "OPEN",
						reviews: reviews("someone", "Jitsusama"),
					},
				},
				p3: { pullRequest: { state: "OPEN", reviews: reviews("someone") } },
				p4: null,
			},
		};

		expect(resolutionsFrom(asked, answer)).toEqual([
			{ id: "a", how: "merged" },
			{ id: "b", how: "closed" },
			{ id: "c", how: "reviewed by Jitsusama" },
		]);
		expect(resolutionsFrom(asked, { errors: [{}] })).toEqual([]);
	});

	it("marks what resolved, leaving a look the person already cleared as it was", () => {
		const merged = look(PR, "Agent sources");
		expect(markResolved(dir, [{ id: merged.id, how: "merged" }])).toBe(1);
		expect(looksIn(dir)[0]).toMatchObject({ state: "resolved", how: "merged" });
		expect(markResolved(dir, [{ id: merged.id, how: "closed" }])).toBe(0);
	});

	it("takes one turn at asking across sessions, every few minutes", () => {
		const now = Date.parse("2026-11-08T14:00:00Z");
		expect(takeTurnToAsk(dir, "S1", now), "the first asks").toBe(true);
		expect(
			takeTurnToAsk(dir, "S2", now + 1_000),
			"another waits its turn",
		).toBe(false);
		expect(
			takeTurnToAsk(dir, "S2", now + ASK_EVERY_MS),
			"and asks once it comes",
		).toBe(true);
	});
});
