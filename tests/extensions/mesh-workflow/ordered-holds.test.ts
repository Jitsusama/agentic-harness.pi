/**
 * What holds a session from an ordered carry, or a move, named all at
 * once: a session held by several things is told of every one in its
 * first answer, not of the first alone and then the next once that
 * one lets go.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { holdsOf } from "../../../extensions/mesh-workflow/moving.ts";
import { orderedHolds } from "../../../extensions/mesh-workflow/ordered-carry.ts";
import { RUN_UNDER_WAY } from "../../../lib/internal/session/free.ts";
import { announceJobHost, type JobHold } from "../../../lib/jobs/index.ts";
import { type Board, createBoard } from "../../../lib/mesh/lease.ts";

const SESSION = "01a19111-holds";

const HOUR_MS = 3_600_000;

const REVIEW: JobHold = { id: "j4", kind: "review", label: "watch #2050" };

/** What a session's state holds it by, besides its jobs and leases. */
interface Held {
	readonly running?: boolean;
	readonly messages?: boolean;
	readonly typed?: string;
	readonly prompts?: number;
	readonly jobs?: readonly JobHold[];
}

/** A session as the holds read it: its context, its job host and its prompts. */
function sessionHeld(held: Held = {}) {
	const events = createEventBus();
	const jobs = held.jobs ?? [];
	announceJobHost(events, {
		start: () => {
			throw new Error("nothing starts here");
		},
		pending: () => jobs.length,
		holds: () => jobs,
	});
	const ctx = {
		hasUI: true,
		ui: { getEditorText: () => held.typed ?? "" },
		isIdle: () => held.running !== true,
		hasPendingMessages: () => held.messages === true,
		sessionManager: { getSessionId: () => SESSION },
	} as unknown as ExtensionContext;
	return { ctx, events, prompts: held.prompts ?? 0 };
}

/** A board on which the session holds a heavy lease, current for an hour either side. */
function heavyLeaseHeld(): Board {
	const board = createBoard(mkdtempSync(join(tmpdir(), "ordered-holds-")));
	board.hold({
		session: SESSION,
		leases: [
			{
				kind: "heavy",
				subject: "nix-build",
				since: new Date(Date.now() - HOUR_MS).toISOString(),
				until: new Date(Date.now() + HOUR_MS).toISOString(),
			},
		],
	});
	return board;
}

/** Expects `said` to name each of `holds`, in whatever order and words join them. */
function expectNamesEach(said: string | undefined, holds: readonly string[]) {
	expect(said, "something holds it").toBeDefined();
	for (const hold of holds) {
		expect(said, `it names ${hold}`).toContain(hold);
	}
}

describe("what holds a session from an ordered carry, named at once", () => {
	it("names both a review watch and a heavy lease the session holds", async () => {
		const at = sessionHeld({ jobs: [REVIEW] });

		const said = await orderedHolds(
			{ ...at, board: heavyLeaseHeld(), session: SESSION },
			true,
		);

		expectNamesEach(said, [
			"a review watch is out (j4: watch #2050)",
			"it holds a lease (heavy on nix-build)",
		]);
	});

	it("names every hold of its own besides its run, and its lease", async () => {
		const at = sessionHeld({
			running: true,
			messages: true,
			jobs: [REVIEW, { id: "j5", kind: "shell", label: "pnpm test:host" }],
			prompts: 1,
			typed: "half a thought",
		});

		const said = await orderedHolds(
			{ ...at, board: heavyLeaseHeld(), session: SESSION },
			true,
		);

		expectNamesEach(said, [
			"messages wait for it",
			"a review watch and a command are out",
			"j4: watch #2050",
			"j5: pnpm test:host",
			"a prompt is open",
			"text is typed and unsent",
			"it holds a lease (heavy on nix-build)",
		]);
		// An ordered carry ends the run itself once nothing else holds.
		expect(said).not.toContain(RUN_UNDER_WAY);
	});
});

describe("what holds a session from a move, named at once", () => {
	it("names its run, its messages, its jobs, its prompt and its typed words together", () => {
		const at = sessionHeld({
			running: true,
			messages: true,
			jobs: [REVIEW],
			prompts: 2,
			typed: "unsent",
		});

		expectNamesEach(holdsOf(at.ctx, at.events, at.prompts), [
			RUN_UNDER_WAY,
			"messages wait for it",
			"a review watch is out (j4: watch #2050)",
			"a prompt is open",
			"text is typed and unsent",
		]);
	});

	// A move ends a run it waited on too long only when the run alone
	// holds (moving.ts), by matching these words exactly.
	it("still says a run alone as just that", () => {
		const at = sessionHeld({ running: true });

		expect(holdsOf(at.ctx, at.events, at.prompts)).toBe(RUN_UNDER_WAY);
	});
});
