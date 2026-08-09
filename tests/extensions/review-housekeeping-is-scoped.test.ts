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
import { ReviewerArtifactsStore } from "../../lib/subagent/index.js";
import { activate } from "./support/review-extension.js";

let root: string;
let wasState: string | undefined;
let said: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-housekeeping-"));
	wasState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = root;
	said = [];
	vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		said.push(parts.map(String).join(" "));
	});
});

afterEach(() => {
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
async function startSession(): Promise<void> {
	const started = activate().lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	await started(
		{ reason: "startup" },
		{ sessionManager: { getSessionId: () => "this-session" } },
	);
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
