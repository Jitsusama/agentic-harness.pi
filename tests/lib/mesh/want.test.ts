/**
 * Wants: what a peer waits on its person for, read from outside and
 * told longest first.
 */
import { describe, expect, it } from "vitest";
import { SAID_CHARS } from "../../../lib/internal/session/wants.ts";
import { longestStanding, wantFrom } from "../../../lib/mesh/want.ts";

describe("a want", () => {
	it("reads from outside as one line no longer than it keeps", () => {
		expect(
			wantFrom({
				kind: "question",
				since: "2026-10-22T08:00:00Z",
				said: "Which\n  launcher?",
			}),
		).toEqual({
			kind: "question",
			since: "2026-10-22T08:00:00.000Z",
			said: "Which launcher?",
		});
		const long = wantFrom({
			kind: "blocked",
			since: "2026-10-22T08:00:00Z",
			said: "x".repeat(SAID_CHARS + 1),
		});
		expect(long?.said).toHaveLength(SAID_CHARS);
		expect(long?.said.endsWith("\u2026")).toBe(true);
	});

	it("is nothing without a kind it knows, a time, or what was said", () => {
		const since = "2026-10-22T08:00:00Z";
		expect(wantFrom({ kind: "lunch", since, said: "hi" })).toBeUndefined();
		expect(
			wantFrom({ kind: "question", since: "soon", said: "hi" }),
		).toBeUndefined();
		expect(wantFrom({ kind: "question", since, said: null })).toBeUndefined();
		expect(wantFrom("question")).toBeUndefined();
	});

	it("tells the one standing longest", () => {
		const at = (since: string) => ({
			kind: "question" as const,
			since,
			said: since,
		});

		expect(
			longestStanding([
				at("2026-10-22T08:00:00.000Z"),
				at("2026-10-22T07:00:00.000Z"),
				at("2026-10-22T09:00:00.000Z"),
			])?.since,
		).toBe("2026-10-22T07:00:00.000Z");
		expect(longestStanding([])).toBeUndefined();
	});
});
