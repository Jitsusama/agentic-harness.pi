/**
 * A fleet is written down before it runs, and released after.
 *
 * The sweep can only keep what something told it to keep, so this is
 * the half that makes protection mean anything: without the write, an
 * interrupted fleet is indistinguishable from an old one and the
 * transcripts go. Both ends matter, and in opposite directions. A
 * write that happens after the fleet finishes protects exactly the
 * fleets that did not need it, and a release that happens only when
 * one succeeds protects every failed fleet forever, which is the
 * unbounded population wearing a different hat.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentCancelledError } from "../../../extensions/subagent-workflow/cancellation.js";
import {
	createFleetLedger,
	type FleetRun,
} from "../../../lib/subagent/fleet.js";
import { systemFacts } from "../../../lib/subagent/lease.js";
import type { RunPi } from "../../../lib/subagent/subagent.js";
import { activateWith } from "../support/review-extension.js";

/** What the supervisor would have spawned, had one been wanted. */
let answer: RunPi;

vi.mock("../../../lib/subagent/runpi/supervisor.js", () => ({
	createSupervisorRunPi: () => (input: unknown) => answer(input as never),
}));

let root: string;
let said: string[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-written-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	said = [];
	vi.spyOn(console, "error").mockImplementation((line: unknown) => {
		said.push(String(line));
	});
	answer = async () => ({
		exitCode: 0,
		finalAssistantText: "done",
		warnings: [],
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Where the extension keeps its fleet ledger. */
function fleetDir(): string {
	return join(root, "pi", "agentic-harness.pi", "subagent-workflow", "fleets");
}

/** Run one fleet through the tool as pi would, and let it be cut off. */
async function dispatchWith(
	runId: string,
	signal: AbortSignal,
): Promise<unknown> {
	const tool = activateWith(
		(await import("../../../extensions/subagent-workflow/index.js")).default,
	).definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	return await tool.execute(
		"call-1",
		{ runId, jobs: [{ id: "one", cwd: root, userPrompt: "go" }] },
		signal,
		undefined,
		{ hasUI: false },
	);
}

/** Run one fleet through the tool as pi would. */
async function dispatch(runId: string): Promise<unknown> {
	const tool = activateWith(
		(await import("../../../extensions/subagent-workflow/index.js")).default,
	).definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	return await tool.execute(
		"call-1",
		{ runId, jobs: [{ id: "one", cwd: root, userPrompt: "go" }] },
		undefined,
		undefined,
		{ hasUI: false },
	);
}

describe("dispatching a fleet", () => {
	it("writes the fleet down and releases it once it is handed back", async () => {
		await dispatch("fleet-a");

		const { runs } = await createFleetLedger(fleetDir()).everyFleet();
		expect(runs).toEqual([
			expect.objectContaining({ id: "fleet-a", jobs: ["one"] }),
		]);
		expect(runs[0]?.open).toBeUndefined();
	});

	it("holds the fleet while it is still running", async () => {
		// Read from inside the run, which is the only moment the claim
		// is about: a ledger checked afterwards cannot tell a fleet
		// written down first from one written down last.
		let duringRun: Awaited<
			ReturnType<ReturnType<typeof createFleetLedger>["everyFleet"]>
		>["runs"] = [];
		answer = async () => {
			duringRun = (await createFleetLedger(fleetDir()).everyFleet()).runs;
			return { exitCode: 0, finalAssistantText: "done", warnings: [] };
		};

		await dispatch("fleet-b");

		expect(duringRun).toEqual([
			expect.objectContaining({ id: "fleet-b", open: true }),
		]);
	});

	it("records the session waiting on it, checkably", async () => {
		// So a later session can tell a fleet running right now from one
		// whose session never came back. Both are open records, and they
		// want opposite things said: the first is nobody else's
		// business, and offering to release it offers to unprotect work
		// that is still being paid for.
		//
		// The birthday is the part that matters. A pid on its own
		// identifies nothing, since the number comes round again and a
		// stranger wearing it reads as this session still being here.
		let duringRun: FleetRun["owner"];
		answer = async () => {
			const { runs } = await createFleetLedger(fleetDir()).everyFleet();
			duringRun = runs[0]?.owner;
			return { exitCode: 0, finalAssistantText: "done", warnings: [] };
		};

		await dispatch("fleet-owned");

		expect(duringRun).toEqual({
			pid: process.pid,
			startedAt: await systemFacts.startedAt(process.pid),
		});
	});

	it("holds a fleet that was cancelled, rather than releasing it", async () => {
		// The ending where nobody receives anything. A failure is handed
		// back and can be gone and looked at; an abort is the answer
		// never reaching the model at all, so whatever the subagents
		// wrote is on disk and nowhere else. That is exactly the
		// population this ledger exists to keep, and settling it here
		// released the protection at the one moment it was working.
		const stop = new AbortController();
		answer = async () => {
			stop.abort();
			throw new Error("cancelled");
		};

		await dispatchWith("fleet-cut", stop.signal).catch(() => undefined);

		const { runs } = await createFleetLedger(fleetDir()).everyFleet();
		expect(runs).toEqual([
			expect.objectContaining({ id: "fleet-cut", open: true }),
		]);
		// And says so, with the two paths a person needs: where the work
		// is, and what to delete once they have read it. Holding
		// something forever without saying so is a disk nobody can
		// account for.
		const about = said.filter((line) => line.includes("fleet-cut"));
		expect(about).toHaveLength(1);
		expect(about[0]).toContain("was cancelled");
		expect(about[0]).toContain("fleet-cut.json");
	});

	it("holds a fleet somebody stopped from the panel", async () => {
		// The cancellation this extension actually documents, and the
		// one a guard on the signal cannot see: a key pressed in the
		// panel leaves the signal untouched and comes back as a result
		// with cancelled entries in it. Reading the signal alone
		// released every fleet a person had stopped on purpose, which is
		// the one population most likely to be worth reading later.
		answer = async () => {
			throw new SubagentCancelledError("one");
		};

		await dispatch("fleet-stopped");

		const { runs } = await createFleetLedger(fleetDir()).everyFleet();
		expect(runs).toEqual([
			expect.objectContaining({ id: "fleet-stopped", open: true }),
		]);
		const about = said.filter((line) => line.includes("fleet-stopped"));
		expect(about).toHaveLength(1);
		expect(about[0]).toContain("1 subagent was cancelled");
	});

	it("releases a fleet whose subagents all failed", async () => {
		// A failure is handed back like anything else: whoever asked has
		// the result and can go and look at what is on disk. Holding
		// these would protect every failure ever run, which is the
		// unbounded population wearing a different hat.
		answer = async () => ({
			exitCode: 1,
			finalAssistantText: "",
			warnings: ["it fell over"],
		});

		await dispatch("fleet-c");

		const { runs } = await createFleetLedger(fleetDir()).everyFleet();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.open).toBeUndefined();
	});

	it("releases a fleet that threw before it asked anybody", async () => {
		// The case the release is written in a finally for. A fleet that
		// throws on its way in never reaches the line after the
		// dispatch, so a release written there holds it forever, and a
		// fleet that never ran is the least worth keeping there is.
		const tool = activateWith(
			(await import("../../../extensions/subagent-workflow/index.js")).default,
		).definitions.get("subagent");
		if (tool === undefined) throw new Error("no subagent tool was registered");

		await expect(
			tool.execute(
				"call-1",
				{
					runId: "fleet-twins",
					jobs: [
						{ id: "one", cwd: root, userPrompt: "go" },
						{ id: "one", cwd: root, userPrompt: "go" },
					],
				},
				undefined,
				undefined,
				{ hasUI: false },
			),
		).rejects.toThrow("Duplicate subagent");

		const { runs } = await createFleetLedger(fleetDir()).everyFleet();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.open).toBeUndefined();
	});

	it("dispatches anyway when the fleet cannot be written down, and says so", async () => {
		// Bookkeeping must not cost a fleet. Failing to record one costs
		// that fleet its protection; refusing to run it costs the whole
		// fleet, which is the worse trade by a wide margin.
		//
		// Out loud, though, and this is the half worth pinning: a silent
		// failure here is a fleet running with nothing protecting it,
		// which is invisible from everywhere else and looks exactly like
		// a fleet that is safe.
		mkdirSync(join(root, "pi", "agentic-harness.pi", "subagent-workflow"), {
			recursive: true,
		});
		// A file where the ledger directory needs to be.
		writeFileSync(fleetDir(), "in the way", "utf8");

		const result = await dispatch("fleet-d");

		expect(result).toMatchObject({ details: { ok: true } });
		const about = said.filter((line) => line.includes("fleet-d"));
		expect(about).toHaveLength(2);
		expect(about[0]).toContain("before dispatching it");
		expect(about[0]).toContain("will not know to keep its transcripts");
		// And the settle, which fails for the same reason and costs
		// something different: not a fleet left unprotected but one left
		// held. Two failures, two sentences.
		expect(about[1]).toContain("could not settle");
	});
});
