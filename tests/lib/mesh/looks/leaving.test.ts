import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	answerLook,
	expireLooks,
	type LookState,
	leaveSeenLooks,
	looksDue,
	looksIn,
	OPENED_LASTS_MS,
	openLook,
	pointAt,
	resolveLooksOfEndedCells,
	sessionsHolding,
	stampOpenedLooks,
	takeBackThread,
} from "../../../../lib/mesh/looks/looks.ts";

// WCJQSG for Joel, 25 November: "my for you list is messy with pi
// session stuff that by the time i get to it is out of date."

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "leaving-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pr = {
	kind: "pr" as const,
	target: "https://github.com/owner/repo/pull/9",
	title: "The narrow bar",
	why: "The bar keeps the model at narrow widths now.",
	ask: "Say whether it reads right.",
};
const who = { session: "S1", quest: "Q1" };
const t0 = new Date("2026-11-25T18:00:00Z");
const later = new Date("2026-11-25T18:30:00Z");

/** The launcher marking look `id` as the person left it, saying no time. */
function mark(id: string, state: LookState): void {
	const file = join(dir, `${id}.json`);
	const look: Record<string, unknown> = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...look, state }));
}

/** Each look's state by its id. */
function states(): Record<string, string> {
	return Object.fromEntries(looksIn(dir).map((one) => [one.id, one.state]));
}

describe("a look the person can't answer in place", () => {
	it("leaves once opened when it asks in words but offers no choices", () => {
		const read = pointAt(dir, pr, who, t0);
		mark(read.id, "opened");

		expect(leaveSeenLooks(dir, later)).toBe(1);
		expect(looksIn(dir)[0]).toMatchObject({ state: "resolved", how: "seen" });
	});

	it("stays opened when it offers choices or takes his own words", () => {
		const picks = pointAt(
			dir,
			{ ...pr, choices: ["Keep It", "Roll It Back"] },
			who,
			t0,
		);
		const words = pointAt(
			dir,
			{
				...pr,
				target: `${pr.target}1`,
				happened: "The status bar now keeps the model at narrow widths.",
				matters: "At 76 columns it showed only the folder.",
				act: "Say How It Reads",
				words: true,
			},
			who,
			t0,
		);
		mark(picks.id, "opened");
		mark(words.id, "opened");

		expect(leaveSeenLooks(dir, later), "neither is a read").toBe(0);
		expect(states()).toEqual({ [picks.id]: "opened", [words.id]: "opened" });
	});
});

describe("an opened look with choices", () => {
	const picking = { ...pr, choices: ["Keep It", "Roll It Back"] };

	it("says when it was opened, whether opened here or by the launcher", () => {
		const here = pointAt(dir, picking, who, t0);
		const there = pointAt(
			dir,
			{ ...picking, target: `${pr.target}1` },
			who,
			t0,
		);

		expect(openLook(dir, here.id, later)?.openedAt).toBe(later.toISOString());
		mark(there.id, "opened");
		expect(
			looksDue(
				looksIn(dir),
				() => true,
				() => false,
				later,
			).unstamped,
			"the launcher's mark says no time",
		).toBe(true);
		expect(stampOpenedLooks(dir, later), "only the unstamped").toBe(1);
		expect(looksIn(dir).map((one) => one.openedAt)).toEqual([
			later.toISOString(),
			later.toISOString(),
		]);
		expect(stampOpenedLooks(dir, t0), "stamped once").toBe(0);
	});

	it("expires a day after it was opened, for its owner, and not before", () => {
		const look = pointAt(dir, picking, who, t0);
		openLook(dir, look.id, later);
		const aDayOn = new Date(later.getTime() + OPENED_LASTS_MS);
		const mine = (one: { quest?: string }) => one.quest === "Q1";

		expect(
			expireLooks(dir, mine, new Date(aDayOn.getTime() - 1)),
			"a moment early",
		).toEqual([]);
		expect(
			expireLooks(dir, () => false, aDayOn),
			"not another's",
		).toEqual([]);
		expect(expireLooks(dir, mine, aDayOn).map((one) => one.id)).toEqual([
			look.id,
		]);
	});

	it("stands unopened again once its owner points at it anew", () => {
		const look = pointAt(dir, picking, who, t0);
		openLook(dir, look.id, t0);
		const renewed = pointAt(dir, picking, who, later);

		expect(renewed).toMatchObject({ id: look.id, state: "waiting" });
		expect(renewed.openedAt, "a fresh look").toBeUndefined();
		expect(
			expireLooks(dir, () => true, new Date(t0.getTime() + OPENED_LASTS_MS)),
			"not on the old opening's clock",
		).toEqual([]);
	});

	it("never expires while it waits unopened", () => {
		pointAt(dir, picking, who, t0);
		expect(expireLooks(dir, () => true, new Date("2027-01-01"))).toEqual([]);
	});
});

describe("a look whose session has ended", () => {
	it("names each session whose looks still stand, once", () => {
		pointAt(dir, pr, who, t0);
		pointAt(dir, { ...pr, target: `${pr.target}1` }, who, t0);
		const cleared = pointAt(dir, pr, { session: "S2", quest: "Q2" }, t0);
		mark(cleared.id, "cleared");
		pointAt(dir, pr, { session: "S3", quest: "Q3" }, t0);

		expect(sessionsHolding(looksIn(dir)).sort()).toEqual(["S1", "S3"]);
	});

	it("resolves with it, leaving the looks of sessions still there", () => {
		const gone = pointAt(dir, pr, { session: "S2", quest: "Q2" }, t0);
		const here = pointAt(dir, pr, who, t0);

		expect(
			resolveLooksOfEndedCells(dir, (look) => look.session === "S2", later),
		).toBe(1);
		const byId = Object.fromEntries(looksIn(dir).map((one) => [one.id, one]));
		expect(byId[gone.id]).toMatchObject({
			state: "resolved",
			how: "its session ended",
		});
		expect(byId[here.id]?.state).toBe("waiting");
	});

	it("leaves a look the person cleared while it was being judged as he left it", () => {
		const look = pointAt(dir, pr, { session: "S2", quest: "Q2" }, t0);

		const marked = resolveLooksOfEndedCells(
			dir,
			() => {
				// The launcher writes between this read and the write.
				mark(look.id, "cleared");
				return true;
			},
			later,
		);

		expect(marked, "nothing written over his clearing").toBe(0);
		expect(looksIn(dir)[0]?.state).toBe("cleared");
	});
});

describe("a session carrying on past its looks", () => {
	it("takes back its own on a thread, not another's nor another thread's", () => {
		const parked = pointAt(dir, { ...pr, thread: "parked question" }, who, t0);
		const other = pointAt(dir, { ...pr, target: `${pr.target}1` }, who, t0);
		const theirs = pointAt(
			dir,
			{ ...pr, thread: "parked question" },
			{ session: "S2", quest: "Q2" },
			t0,
		);

		expect(takeBackThread(dir, "S1", "parked question", later)).toBe(1);
		const byId = Object.fromEntries(looksIn(dir).map((one) => [one.id, one]));
		expect(byId[parked.id]).toMatchObject({
			state: "resolved",
			how: "its session carried on",
		});
		expect(byId[other.id]?.state, "another thread").toBe("waiting");
		expect(byId[theirs.id]?.state, "another session's").toBe("waiting");
		expect(takeBackThread(dir, "S1", "parked question", later), "once").toBe(0);
	});

	it("still hears the person's pick when it lands just after the take-back", () => {
		const parked = pointAt(
			dir,
			{ ...pr, thread: "parked question", choices: ["Keep It", "Drop It"] },
			who,
			t0,
		);
		takeBackThread(dir, "S1", "parked question", later);
		const value = parked.choices?.[0]?.value ?? "";

		expect(answerLook(dir, parked.id, { value }, later)).toMatchObject({
			state: "resolved",
			answer: value,
		});
		expect(
			answerLook(dir, parked.id, { value }, later),
			"answered once",
		).toBeUndefined();
	});
});
