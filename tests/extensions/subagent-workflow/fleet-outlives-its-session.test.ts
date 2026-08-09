/**
 * A fleet's transcripts are not reclaimed while nobody has read them.
 *
 * A fleet's answers exist in two places: the tool result handed to
 * the session that asked, and the transcripts on disk. When the
 * session dies mid-fleet the first never happens, so the second is
 * the only copy, and until the ledger existed nothing said so: the
 * sweep saw run directories of the ordinary age and took them.
 *
 * The review side learned this the expensive way, over five councils
 * and a first fix that was backwards. Everything here is the same
 * argument one layer down, so the cases are deliberately the same
 * cases.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentWorkflow from "../../../extensions/subagent-workflow/index.js";
import { createFleetLedger } from "../../../lib/subagent/fleet.js";
import { ReviewerArtifactsStore } from "../../../lib/subagent/index.js";
import { activateWith } from "../support/review-extension.js";

let root: string;
let said: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-sweep-"));
	// The extension resolves its state directory from the environment
	// on every call, which is what makes it redirectable at all.
	vi.stubEnv("XDG_STATE_HOME", root);
	said = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => {
		said.push(String(line));
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Where the extension keeps its subagent state. */
function stateDir(...parts: string[]): string {
	return join(root, "pi", "agentic-harness.pi", "subagent-workflow", ...parts);
}

/** A finished fleet's transcripts, old enough for the ordinary window. */
function staleFleet(id: string): string {
	const paths = new ReviewerArtifactsStore(stateDir()).paths(id, "one");
	mkdirSync(join(paths.resultPath, ".."), { recursive: true });
	writeFileSync(paths.resultPath, JSON.stringify({ ok: true }), "utf8");
	// Aged by the caller rather than here, because writing the result
	// file above moves the run directory's mtime and this would then
	// be aging a directory that is about to look new again.
	return paths.runDir;
}

/** Age a path past every ordinary window. */
async function age(path: string): Promise<void> {
	const long = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	await utimes(path, long, long);
}

/** Start the session the way pi starts one. */
async function startSession(): Promise<void> {
	const started = activateWith(subagentWorkflow).lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	await started({ reason: "startup" }, {});
}

describe("the fleet retention sweep", () => {
	it("reclaims a fleet somebody has been handed", async () => {
		// The other side of everything below. Without it a sweep that
		// never ran would pass every case here, since one that deletes
		// nothing also destroys nothing.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-done",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		await ledger.settle("fleet-done");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
	});

	it("keeps a fleet nobody has collected, however old", async () => {
		// The one that matters. An open fleet is one whose session did
		// not live to hand it back, so these transcripts are the only
		// copy of what was paid for, and no clock makes that untrue.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-orphan",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		const transcripts = staleFleet("fleet-orphan");
		await age(transcripts);

		await startSession();

		// Waited on the other one going, so this is not merely a sweep
		// that had not started yet.
		const other = staleFleet("fleet-nobody-recorded");
		await age(other);
		await startSession();
		await vi.waitFor(() => expect(existsSync(other)).toBe(false));
		expect(existsSync(transcripts)).toBe(true);
	});

	it("forgets a settled record once its transcripts have gone", async () => {
		// The seam that makes the ledger's own window real. Without the
		// call, `fleets/` is the unbounded thing the ledger was built to
		// bound: one small file per fleet ever dispatched, all of them
		// read at every session start, long after what they point at
		// has been reclaimed.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-ancient",
			startedAt: "2019-01-01T00:00:00.000Z",
			jobs: ["one"],
		});
		await ledger.settle("fleet-ancient");
		const record = join(stateDir("fleets"), "fleet-ancient.json");
		const old = JSON.parse(readFileSync(record, "utf8"));
		writeFileSync(
			record,
			JSON.stringify({ ...old, settledAt: "2019-01-01T00:00:00.000Z" }),
			"utf8",
		);

		await startSession();

		await vi.waitFor(() => expect(existsSync(record)).toBe(false));
	});

	it("declines the sweep when the fleet ledger will not read", async () => {
		// An empty protect set is not the cautious reading of a ledger
		// that will not open, it is the destructive one: every fleet
		// that finished on disk then looks like one nobody needs.
		mkdirSync(stateDir("fleets"), { recursive: true });
		writeFileSync(stateDir("fleets", "torn.json"), "{ not json", "utf8");
		const transcripts = staleFleet("fleet-done");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("will not be swept"));
			expect(about).toHaveLength(1);
			expect(about[0]).toContain("torn.json");
			expect(about[0]).toContain("every session");
		});
		expect(existsSync(transcripts)).toBe(true);
	});

	it("says how many fleets are being held once there are enough to matter", async () => {
		// Protection is absolute, so this is the population that can
		// grow without a limit, and nothing else would ever mention it:
		// a fleet nobody collected is by definition one nobody knows
		// about.
		//
		// Counted from what the sweep held rather than from what the
		// ledger says, so each of these has transcripts on disk. The two
		// numbers are not the same: a fleet can be open on the ledger
		// with nothing behind it at all, and a message announcing
		// megabytes that are not there sends somebody looking for a
		// directory that does not exist.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
			await age(staleFleet(`fleet-${n}`));
		}

		await startSession();

		await vi.waitFor(() => {
			const about = said.filter((line) => line.includes("never handed back"));
			expect(about).toHaveLength(1);
			expect(about[0]).toContain("5 fleet runs");
			// Where they are, and how to let one go. Announcing an
			// unbounded population that nothing in the product can
			// release, without saying what releases it, is a nag with no
			// answer.
			expect(about[0]).toContain(stateDir("runs"));
			expect(about[0]).toContain(stateDir("fleets"));
		});
	});

	it("says nothing about fleets the ledger holds but the disk does not", async () => {
		// The other half of counting what was held. Five open records
		// with no transcripts behind them is five fleets whose
		// dispatches never got as far as writing anything, and there is
		// nothing there to go and look at.
		const ledger = createFleetLedger(stateDir("fleets"));
		for (let n = 0; n < 5; n++) {
			await ledger.open({
				id: `fleet-${n}`,
				startedAt: new Date().toISOString(),
				jobs: ["one"],
			});
		}

		await startSession();

		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);
		await startSession();
		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
		expect(said).toEqual([]);
	});

	it("says nothing while only a few are held", async () => {
		// A channel that speaks every session is a channel nobody
		// reads, and one held fleet is the ordinary state of a machine
		// that ran one this morning.
		const ledger = createFleetLedger(stateDir("fleets"));
		await ledger.open({
			id: "fleet-0",
			startedAt: new Date().toISOString(),
			jobs: ["one"],
		});
		const transcripts = staleFleet("fleet-swept");
		await age(transcripts);

		await startSession();

		await vi.waitFor(() => expect(existsSync(transcripts)).toBe(false));
		expect(said).toEqual([]);
	});
});
