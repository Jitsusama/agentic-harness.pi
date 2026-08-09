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

/** Start the session the way pi starts one, and wait as pi waits. */
async function startSession(stub: ReturnType<typeof activate>): Promise<void> {
	const started = stub.lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	await started(
		{ reason: "startup" },
		{ sessionManager: { getSessionId: () => "this-session" } },
	);
	// The housekeeping is deliberately not awaited by the handler, so
	// that a sweep never delays a session. Give it the turns it needs.
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("housekeeping at session start", () => {
	it("prunes attachments even when the ledger cannot be read", async () => {
		// The one that matters. A torn ledger is a reason to leave the
		// transcripts alone, and no reason at all to stop pruning
		// attachments, which do not depend on it.
		mkdirSync(stateDir("runs"), { recursive: true });
		writeFileSync(stateDir("runs", "torn.json"), "{ not json", "utf8");
		const stale = staleAttachment("someone-elses-session");

		await startSession(activate());

		expect(await readdir(stateDir("attached"))).toEqual([]);
		expect(stale).toContain("attached");
	});

	it("says which ledger file stopped it, rather than sweeping anyway", async () => {
		// An empty protect set is not the cautious reading of a ledger
		// that will not open, it is the destructive one: every detached
		// round that finished on disk is terminal, so with nothing
		// protecting it the ordinary window takes it.
		mkdirSync(stateDir("runs"), { recursive: true });
		writeFileSync(stateDir("runs", "torn.json"), "{ not json", "utf8");

		await startSession(activate());

		const about = said.filter((line) => line.includes("were not swept"));
		expect(about).toHaveLength(1);
		expect(about[0]).toContain("torn.json");
	});

	it("says nothing on an ordinary start", async () => {
		// A channel that speaks every session is a channel nobody reads,
		// and everything here is advisory, so silence is the ordinary
		// outcome and worth pinning.
		mkdirSync(stateDir("runs"), { recursive: true });

		await startSession(activate());

		expect(said).toEqual([]);
	});
});
