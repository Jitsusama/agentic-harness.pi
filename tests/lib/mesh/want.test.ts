/**
 * Wants: what a peer waits on its person for, read from outside and
 * told longest first.
 */
import { describe, expect, it } from "vitest";
import { SAID_CHARS } from "../../../lib/internal/session/wants.ts";
import { longestStanding, wantFrom, wantId } from "../../../lib/mesh/want.ts";

describe("a want", () => {
	it("reads from outside as one line no longer than it keeps", () => {
		expect(
			wantFrom({
				kind: "question",
				since: "2026-10-22T08:00:00Z",
				said: "Which\n  launcher?",
			}),
		).toEqual({
			id: "question@2026-10-22T08:00:00.000Z",
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
		expect(long?.said).toMatch(/\u2026$/);
	});

	it("keeps its id as what it says changes", () => {
		// The launcher keys its notice by the id: keyed by the words, each new
		// count of calls held posted the notice and its sound again.
		const since = "2026-10-22T08:00:00Z";
		const one = wantFrom({ kind: "approval", since, said: "Holds a call" });
		const three = wantFrom({ kind: "approval", since, said: "Holds 3 calls" });

		expect(three?.id).toBe(one?.id);
		expect(
			wantFrom({ kind: "question", since, said: "Holds a call" })?.id,
		).not.toBe(one?.id);
	});

	it("is nothing without a kind it knows, a time, or what was said", () => {
		const since = "2026-10-22T08:00:00Z";
		expect(wantFrom({ kind: "lunch", since, said: "hi" })).toBeUndefined();
		expect(
			wantFrom({ kind: "question", since: "soon", said: "hi" }),
		).toBeUndefined();
		expect(wantFrom({ kind: "question", since, said: null })).toBeUndefined();
		// mesh_wait's items are no want: Needs You reads them from their file.
		expect(wantFrom({ kind: "action", since, said: "Log in" })).toBeUndefined();
		expect(wantFrom("question")).toBeUndefined();
	});

	it("keeps an ask's choices it can read, and drops ones it can't", () => {
		const since = "2026-10-22T08:00:00Z";
		const ask = {
			choices: [{ value: "keep", label: "Keep it", description: "As is" }],
			recommended: "keep",
			allowOther: false,
		};

		expect(
			wantFrom({ kind: "question", since, said: "Keep?", ask })?.ask,
			"the choices read whole",
		).toEqual(ask);
		const bad = wantFrom({
			kind: "question",
			since,
			said: "Keep?",
			ask: { choices: [{ value: 3, label: "Keep it" }] },
		});
		expect(bad, "the want still reads").toBeDefined();
		expect(bad, "without choices it can't offer").not.toHaveProperty("ask");
	});

	it("tells the one standing longest", () => {
		const at = (since: string) => ({
			id: wantId("question", since),
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
