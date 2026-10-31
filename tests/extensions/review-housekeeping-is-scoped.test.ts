/**
 * What one piece of session-start housekeeping may decide for another.
 *
 * Three sweeps run when a session starts, and only one of them reads
 * the round ledger. That one has a reason to decline: an incomplete
 * protect set is worse than no sweep, because the rounds missing from
 * it are detached ones that finished on disk, and nothing protecting
 * a finished run means the ordinary week takes findings nobody has
 * read.
 *
 * Declining was written twice as a bare return, and both times it
 * returned from the whole housekeeping function and quietly cancelled
 * the attachment prune and the orphan reaper as well. Nothing said
 * so, because nothing here was tested: the seam the other extension
 * tests use was already there, and this file is what should have been
 * using it.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AskRun,
	type ChangeRef,
	createRunStore,
} from "../../lib/core/review/index.ts";
import { ReviewerArtifactsStore } from "../../lib/subagent/index.ts";
import { activate } from "./support/review-extension.ts";

let root: string;
let wasState: string | undefined;
let said: string[];
let behind: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-housekeeping-"));
	wasState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = root;
	said = [];
	behind = [];
	// Anything written to the terminal directly lands in pi's editor and
	// throws its picture of the screen out (lib/ui/aside.ts), so it is
	// kept apart from what the person is told, and must stay empty.
	for (const level of ["error", "warn"] as const) {
		vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
			behind.push(parts.map(String).join(" "));
		});
	}
});

afterEach(() => {
	expect(behind).toEqual([]);
	vi.restoreAllMocks();
	if (wasState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = wasState;
	rmSync(root, { recursive: true, force: true });
});

/** Under the sandboxed state directory, where review keeps a thing. */
function stateDir(...parts: string[]): string {
	return join(root, "pi", "agentic-harness.pi", "review", ...parts);
}

/**
 * Another session's attachment, old enough that the prune takes it.
 *
 * A directory rather than a file, and aged by its mtime, because that
 * is what the prune walks and what it reads.
 */
function staleAttachment(session: string): string {
	const path = stateDir("attached", session);
	mkdirSync(path, { recursive: true });
	const held = join(path, "attached.json");
	writeFileSync(
		held,
		JSON.stringify({
			change: {
				provider: "github",
				repo: { key: "github:Jitsusama/agentic-harness.pi" },
				id: "1",
				label: "one#1",
			},
		}),
		"utf8",
	);
	const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	utimesSync(held, long, long);
	utimesSync(path, long, long);
	return path;
}

/**
 * A finished round's transcripts, old enough for the ordinary window.
 *
 * The thing the sweep is for, and the thing the first version of this
 * file never put on disk: with no transcripts tree the sweep walks
 * nothing, reclaims nothing and reports nothing, so every assertion
 * here passed whether it declined or swept.
 */
function staleRound(id: string): string {
	const paths = new ReviewerArtifactsStore(stateDir("transcripts")).paths(
		id,
		"one",
	);
	mkdirSync(join(paths.resultPath, ".."), { recursive: true });
	writeFileSync(paths.resultPath, JSON.stringify({ ok: true }), "utf8");
	const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	utimesSync(paths.runDir, long, long);
	return paths.runDir;
}

/**
 * Start the session the way pi starts one.
 *
 * The housekeeping is deliberately not awaited by the handler, so a
 * sweep never delays a session. Every assertion about it therefore
 * waits for the state it expects rather than for a fixed pause, which
 * is a race dressed as a delay.
 */
async function startSession(): Promise<{
	sent: { content: unknown; display?: boolean }[];
}> {
	const extension = activate();
	const started = extension.lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	await started(
		{ reason: "startup" },
		{
			sessionManager: { getSessionId: () => "this-session" },
			// A screen, whose notices are what the person is told.
			hasUI: true,
			ui: { notify: (text: string) => said.push(text) },
		},
	);
	return { sent: extension.sent };
}

/**
 * How long a collect at session start may take: it reads the round
 * back and files what it found, which on a busy machine is seconds.
 */
const SETTLES_MS = 10_000;

const CHANGE: ChangeRef = {
	provider: "github",
	repo: { key: "github:Jitsusama/agentic-harness.pi" },
	id: "7",
	label: "Jitsusama/agentic-harness.pi#7",
};

/**
 * A council open on the ledger whose one reviewer finished, as a round
 * looks once somebody stopped it, or its session went, uncollected.
 */
async function openRound(
	id: string,
	over: Partial<AskRun> = {},
): Promise<void> {
	const paths = new ReviewerArtifactsStore(stateDir("transcripts")).paths(
		id,
		"hawk",
	);
	mkdirSync(paths.reviewerDir, { recursive: true });
	writeFileSync(
		paths.resultPath,
		JSON.stringify({
			schemaVersion: 1,
			runId: id,
			reviewerId: "hawk",
			state: "complete",
			exitCode: 0,
			finalAssistantText: JSON.stringify({ findings: [] }),
		}),
		"utf8",
	);
	// Its supervisor said it finished, as a real one does: a reviewer with
	// no lease reads as handed over and not yet begun.
	const at = new Date().toISOString();
	writeFileSync(
		paths.leasePath,
		JSON.stringify({
			supervisorPid: 1,
			supervisorStartedAt: Date.now() - 60_000,
			updatedAt: at,
			completedAt: at,
		}),
		"utf8",
	);
	await createRunStore(stateDir("runs")).keep(CHANGE, {
		id,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [],
		open: true,
		...over,
	});
}

/** Whether the ledger still holds `id` open. */
async function stillOpen(id: string): Promise<boolean> {
	const held = await createRunStore(stateDir("runs")).byId(CHANGE, id);
	return held?.open === true;
}

describe("housekeeping at session start", () => {
	it("sweeps a finished round when the ledger reads", async () => {
		// The other side of everything below. Without it, declining
		// unconditionally passes the lot, since a sweep that never runs
		// deletes nothing and reports nothing either way.
		mkdirSync(stateDir("runs"), { recursive: true });
		const round = staleRound("council-old");

		await startSession();

		await vi.waitFor(() => expect(existsSync(round)).toBe(false));
	});

	it("leaves a finished round alone when the ledger will not read", async () => {
		// An empty protect set is not the cautious reading of a ledger
		// that will not open, it is the destructive one: a detached round
		// that finished on disk is terminal, so with nothing protecting
		// it the ordinary window takes findings nobody has read.
		mkdirSync(stateDir("runs"), { recursive: true });
		writeFileSync(stateDir("runs", "torn.json"), "{ not json", "utf8");
		const round = staleRound("council-old");

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("will not be swept"));
			expect(about).toHaveLength(1);
			// Naming the file, and naming it as something to go and deal
			// with: nothing repairs a torn ledger, so this is every sweep
			// from here rather than one deferred.
			expect(about[0]).toContain("torn.json");
			expect(about[0]).toContain("every session");
		});
		expect(existsSync(round)).toBe(true);
	});

	it("prunes attachments even so", async () => {
		// The one this file exists for. Declining the transcript sweep
		// was twice written as a bare return, and twice returned from the
		// whole housekeeping function, cancelling sweeps that never read
		// the ledger that stopped it.
		//
		// The orphan reaper is the third of them and is not pinned here.
		// Watching it needs a lease naming a live process whose
		// supervisor is gone, and the fixture for that is a test that
		// kills things; it has its own tests over an injected reaper. So
		// this holds the ordering property through the sweep that can be
		// watched from outside, and the reaper below it is only as safe
		// as this one staying honest.
		mkdirSync(stateDir("runs"), { recursive: true });
		writeFileSync(stateDir("runs", "torn.json"), "{ not json", "utf8");
		staleAttachment("someone-elses-session");

		await startSession();

		await vi.waitFor(async () =>
			expect(await readdir(stateDir("attached"))).toEqual([]),
		);
	});

	it("collects this session's own finished round, and shows nobody", async () => {
		await openRound("council-mine", { startedBy: "this-session" });

		const { sent } = await startSession();

		await vi.waitFor(
			async () => expect(await stillOpen("council-mine")).toBe(false),
			{ timeout: SETTLES_MS },
		);
		expect(said).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("leaves another session's round of today alone, and says nothing of it", async () => {
		// On 30 October every session was told, on Joel's screen, of the
		// ten rounds open across the machine, none of them its own.
		for (let n = 0; n < 10; n++) {
			await openRound(`council-theirs-${n}`, { startedBy: "another-session" });
		}
		mkdirSync(stateDir("runs"), { recursive: true });
		const round = staleRound("council-old");

		const { sent } = await startSession();

		await vi.waitFor(() => expect(existsSync(round)).toBe(false));
		expect(await stillOpen("council-theirs-0")).toBe(true);
		expect(said).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("collects anybody's finished round once it is a day old", async () => {
		const before = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await openRound("council-abandoned", {
			startedBy: "a-session-long-gone",
			startedAt: before.toISOString(),
		});

		await startSession();

		await vi.waitFor(
			async () => expect(await stillOpen("council-abandoned")).toBe(false),
			{ timeout: SETTLES_MS },
		);
		expect(said).toEqual([]);
	});

	it("tells this session's model, never the screen, of its own round it can't collect", async () => {
		// A ledger written before ledgers named their change: the round
		// can't be collected from here, so its session is told how.
		mkdirSync(stateDir("runs"), { recursive: true });
		writeFileSync(
			stateDir("runs", "old-ledger.json"),
			JSON.stringify({
				runs: [
					{
						id: "council-unnamed",
						round: "council",
						startedAt: new Date().toISOString(),
						participants: [],
						outcomes: [],
						open: true,
						startedBy: "this-session",
					},
				],
			}),
			"utf8",
		);

		const { sent } = await startSession();

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.display).toBe(false);
		expect(String(sent[0]?.content)).toContain("council-unnamed");
		expect(String(sent[0]?.content)).toContain("review_ask collect");
		expect(said).toEqual([]);
	});

	it("says nothing on an ordinary start", async () => {
		// A channel that speaks every session is a channel nobody reads,
		// and all of this is advisory. Paired with a sweep that has work
		// to do, so it cannot be satisfied by nothing having run.
		mkdirSync(stateDir("runs"), { recursive: true });
		const round = staleRound("council-old");

		await startSession();

		await vi.waitFor(() => expect(existsSync(round)).toBe(false));
		expect(said).toEqual([]);
	});
});
