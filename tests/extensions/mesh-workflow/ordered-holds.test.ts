/**
 * What holds a session from an ordered carry, or a move, named all at
 * once: a session held by several things is told of every one in its
 * first answer, not of the first alone and then the next once that
 * one lets go.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
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

describe("what holds a session from an ordered carry, from code its install left", () => {
	const installs: string[] = [];
	afterEach(() => {
		for (const install of installs.splice(0)) {
			rmSync(install, { recursive: true, force: true });
		}
	});

	/**
	 * An install whose `current` left the version it answers an hour ago,
	 * past the bar, with a board of no leases beside it.
	 */
	function staleInstall(): { readonly old: string; readonly board: Board } {
		const install = mkdtempSync(join(tmpdir(), "ordered-holds-install-"));
		installs.push(install);
		const made = (version: string, ago: number) => {
			const at = join(install, "versions", version);
			mkdirSync(at, { recursive: true });
			const when = (Date.now() - ago) / 1000;
			utimesSync(at, when, when);
			return at;
		};
		const old = made("03c16f4cfe6b0b8ed5afba531da67409c1d6729c", 50 * HOUR_MS);
		made("9255f6d13012e75c85e1b7e9dab118755c1d7f94", HOUR_MS);
		symlinkSync(
			join("versions", "9255f6d13012e75c85e1b7e9dab118755c1d7f94"),
			join(install, "current"),
		);
		return { old, board: createBoard(join(install, "board")) };
	}

	it("names the harness it runs as a hold while its run is untouched", async () => {
		const { old, board } = staleInstall();
		const at = sessionHeld({ running: true });

		const said = await orderedHolds(
			{ ...at, board, session: SESSION, root: old },
			false,
		);

		expectNamesEach(said, [
			"it runs harness 03c16f4cfe6b, which its install left 60 minutes ago",
		]);
	});

	it("names no harness once its run has ended, since the carry judged it before ending the run", async () => {
		const { old, board } = staleInstall();
		const at = sessionHeld();

		const said = await orderedHolds(
			{ ...at, board, session: SESSION, root: old },
			true,
		);

		expect(said).toBeUndefined();
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
