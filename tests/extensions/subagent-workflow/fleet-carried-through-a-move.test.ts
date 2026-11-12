/**
 * A background fleet carried through its session's move into a host.
 *
 * A move used to stop every subagent of a running fleet, so a session
 * with one in the background could not move without losing paid work.
 * Now the moving pi lets the fleet go, its subagents run on under their
 * supervisors, and the conversation that takes the session up says the
 * summary under the same job id and run id. What has to hold: nothing
 * the moving pi stops reaches the subagents once it has let them go,
 * each subagent is said however it ended, none is lost quietly, and
 * each subagent's spend is recorded once, in the same conversation.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CarriedFleet,
	type FleetTakeUpFacts,
	isCarriedFleet,
	takesUpCarriedFleets,
	takeUpFleet,
} from "../../../extensions/subagent-workflow/carry.ts";
import {
	recordRunEverywhere,
	registerRunRecorder,
} from "../../../lib/core/observability/recorder.ts";
import type { RunRecord } from "../../../lib/core/observability/types.ts";
import { withSession } from "../../../lib/core/session/identity.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import {
	announceJobHost,
	type CarriedWork,
	type Job,
	type JobCarry,
	type JobHost,
	type JobOutcome,
	type JobSpec,
} from "../../../lib/jobs/index.ts";
import { offerCarried } from "../../../lib/jobs/take-up.ts";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import { createFleetLedger } from "../../../lib/subagent/fleet.ts";
import { parentPath, readParent } from "../../../lib/subagent/handing.ts";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { installTestHost } from "../../support/session-host.ts";
import { until } from "../../support/until.ts";
import { activateWith } from "../support/review-extension.ts";

let answer: RunPi;

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: () => (input: unknown) => answer(input as never),
}));

const OWNER_MODE = 0o600;
const PERMISSION_BITS = 0o777;
const OWNER = { pid: 5151, startedAt: 1_760_000_000_000 };

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-carried-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	// The person's own config is not this test's to read.
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** A job as a host gives one, recording what it was told. */
function recordingJob(id = "j7") {
	const outcomes: JobOutcome[] = [];
	const stop = new AbortController();
	const delivered: (() => void)[] = [];
	const job: Job = {
		id,
		signal: stop.signal,
		finish: (outcome) => outcomes.push(outcome),
		onDelivered: (listener) => delivered.push(listener),
		withdraw: () => false,
	};
	return { job, outcomes, stop, delivered };
}

/** A host that keeps the carry each job was started with. */
function carryingHost() {
	const { job, outcomes, stop } = recordingJob();
	const carries: (JobCarry | undefined)[] = [];
	const host: JobHost = {
		start: (spec: JobSpec): Job => {
			carries.push(spec.carry);
			return job;
		},
	};
	return { host, carries, outcomes, stop };
}

/** Dispatch a two-subagent fleet in the background, in conversation `session`. */
async function dispatch(host: JobHost, session: string | undefined) {
	const stub = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	);
	announceJobHost(stub.pi.events as never, host);
	const tool = stub.definitions.get("subagent");
	if (tool === undefined) throw new Error("no subagent tool was registered");
	await tool.execute(
		"call-1",
		{
			runId: "fleet-moving",
			background: true,
			jobs: [
				{ id: "one", cwd: root, userPrompt: "go" },
				{ id: "two", cwd: root, userPrompt: "go" },
			],
		},
		undefined,
		undefined,
		{
			hasUI: false,
			sessionManager: { getSessionId: () => session },
		},
	);
}

/** Subagents that end only when told, each seeing its own signal. */
function heldSubagents() {
	const signals = new Map<string, AbortSignal>();
	const release = new Map<string, () => void>();
	answer = (input) =>
		new Promise((resolve) => {
			const id = input.reviewerId ?? "";
			if (input.signal) signals.set(id, input.signal);
			release.set(id, () =>
				resolve({
					exitCode: 0,
					finalAssistantText: `${id} done`,
					warnings: [],
				}),
			);
		});
	return { signals, release };
}

describe("a background fleet as its session moves", () => {
	it("offers the fleet to carry, naming its conversation and subagents", async () => {
		const { release } = heldSubagents();
		const { host, carries } = carryingHost();

		await dispatch(host, "conv-1");
		await until("both subagents to start", () => release.size === 2);

		const work = carries[0]?.what();
		expect(work).toMatchObject({
			kind: "subagent",
			runId: "fleet-moving",
			session: "conv-1",
			members: [{ id: "one" }, { id: "two" }],
			recorded: [],
		});
		expect(
			work !== undefined && isCarriedFleet(work),
			"the carry offers a carried fleet",
		).toBe(true);
	});

	it("offers nothing to carry for a fleet no conversation could take up", async () => {
		const { release } = heldSubagents();
		const { host, carries } = carryingHost();

		await dispatch(host, undefined);
		await until("both subagents to start", () => release.size === 2);

		expect(carries[0]?.what()).toBeUndefined();
	});

	it("lets its subagents run on once handed, saying so in parent.json", async () => {
		const { signals, release } = heldSubagents();
		const { host, carries, stop } = carryingHost();
		await dispatch(host, "conv-1");
		await until("both subagents to start", () => signals.size === 2);

		carries[0]?.handed();
		// The closing pi stops every job it still holds.
		stop.abort();

		expect([...signals.values()].map((signal) => signal.aborted)).toEqual([
			false,
			false,
		]);
		const runDir = new ReviewerArtifactsStore(
			stateDir("subagent-workflow"),
		).rootPaths("fleet-moving").runDir;
		expect(statSync(parentPath(runDir)).mode & PERMISSION_BITS).toBe(
			OWNER_MODE,
		);
		expect(readParent(runDir)).toMatchObject({
			handing: { note: { session: "conv-1" } },
		});
		release.get("one")?.();
		release.get("two")?.();
		await until("the fleet to end here", async () =>
			(await ledgerRuns()).some((run) => run.id === "fleet-moving"),
		);
		const [run] = await ledgerRuns();
		expect(run?.open, "the taker settles it, not the pi that let it go").toBe(
			true,
		);
	});

	it("leaves recording a subagent that ends after the hand-over to the taker", async () => {
		const { signals, release } = heldSubagents();
		const { host, carries } = carryingHost();
		const recorded: RunRecord[] = [];
		const unregister = registerRunRecorder((one) => recorded.push(one));
		try {
			await dispatch(host, undefined);
			await until("both subagents to start", () => signals.size === 2);
			release.get("one")?.();
			await until("one to be recorded", () => recorded.length === 1);
			carries[0]?.handed();
			release.get("two")?.();
			// Nothing to wait for: the record is written as the run settles.
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			unregister();
		}

		expect(recorded.map((one) => one.subagentId)).toEqual(["one"]);
	});
});

/** The fleet ledger's records, in the state folder these tests use. */
async function ledgerRuns() {
	return (
		await createFleetLedger(
			join(stateDir("subagent-workflow"), "fleets"),
		).everyFleet()
	).runs;
}

/** Write `value` as JSON at `path`, making its folder. */
function put(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

/**
 * A fleet a move carried, of three subagents: one that ended, one its
 * supervisor stopped for want of a taker, and one whose supervisor went
 * with no result.
 */
async function carriedFleet(): Promise<CarriedFleet> {
	const runs = join(root, "runs-state");
	const fleets = join(root, "fleets");
	const store = new ReviewerArtifactsStore(runs);
	put(store.paths("fleet-moving", "one").resultPath, {
		state: "complete",
		exitCode: 0,
		finalAssistantText: "one done",
		usage: {
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: {
				input: 0.01,
				output: 0.01,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.02,
			},
		},
	});
	put(store.paths("fleet-moving", "two").resultPath, {
		state: "parent-exit",
		exitCode: 1,
		finalAssistantText: "",
	});
	put(store.paths("fleet-moving", "two").progressPath, {
		activity: "reading the plan",
	});
	put(store.paths("fleet-moving", "three").leasePath, {
		supervisorPid: 0,
		updatedAt: new Date().toISOString(),
	});
	await createFleetLedger(fleets).open({
		id: "fleet-moving",
		startedAt: new Date().toISOString(),
		jobs: ["one", "two", "three"],
		owner: { pid: 4242, startedAt: 1_760_000_000_000 },
	});
	return {
		kind: "subagent",
		runId: "fleet-moving",
		session: "conv-1",
		members: [
			{ id: "one", model: "m" },
			{ id: "two", model: "m" },
			{ id: "three", model: "m" },
		],
		recorded: ["one"],
		startedAt: Date.now(),
		runs,
		fleets,
		ranOn: "Ran on m.",
	};
}

/** What the taker's process is, in these tests. */
function facts(record: (one: RunRecord) => void): FleetTakeUpFacts {
	return {
		owner: async () => OWNER,
		ticks: { alive: () => false, startedAt: async () => undefined },
		now: Date.now,
		pause: async () => {},
		record,
	};
}

describe("a carried fleet taken up", () => {
	it("says every subagent however it ended, under the same job", async () => {
		const fleet = await carriedFleet();
		const { job, outcomes, delivered } = recordingJob();

		await takeUpFleet(
			fleet,
			job,
			facts(() => {}),
		);

		expect(outcomes).toHaveLength(1);
		const summary = outcomes[0]?.summary ?? "";
		expect(summary).toMatch(/^Ran on m\./);
		expect(summary).toContain("fleet-moving");
		expect(summary).toContain("1/3 complete");
		expect(summary).toMatch(/two[\s\S]*cut off in the move/);
		expect(summary).toContain("reading the plan");
		expect(summary).toMatch(/three[\s\S]*lost in the move/);
		expect(summary).toContain("carried here by a move");
		expect(delivered).toHaveLength(1);
	});

	it("takes the fleet over as its owner, and lets go once its summary is said", async () => {
		const fleet = await carriedFleet();
		const { job, delivered } = recordingJob();
		const { runDir } = new ReviewerArtifactsStore(fleet.runs).rootPaths(
			fleet.runId,
		);

		await takeUpFleet(
			fleet,
			job,
			facts(() => {}),
		);

		expect(readParent(runDir)).toEqual({ owner: OWNER });
		const [run] = (await createFleetLedger(fleet.fleets).everyFleet()).runs;
		expect(run?.owner).toEqual(OWNER);
		expect(run?.open, "its ledger record is settled").toBeUndefined();
		for (const listener of delivered) listener();
		expect(readParent(runDir)).toBeUndefined();
	});

	it("records only the subagents the moving pi had not", async () => {
		const fleet = await carriedFleet();
		const recorded: RunRecord[] = [];

		await takeUpFleet(
			fleet,
			recordingJob().job,
			facts((one) => recorded.push(one)),
		);

		expect(recorded.map((one) => one.subagentId)).toEqual(["two"]);
		expect(recorded[0]).toMatchObject({ runId: "fleet-moving", kind: "fleet" });
	});

	it("records the spend in the conversation that took it up, and no other", async () => {
		const host = installTestHost();
		const here: RunRecord[] = [];
		const elsewhere: RunRecord[] = [];
		const off = [
			registerRunRecorder((one) => here.push(one), "conv-1"),
			registerRunRecorder((one) => elsewhere.push(one), "conv-2"),
		];
		try {
			const fleet = await carriedFleet();
			await withSession("conv-1", () =>
				takeUpFleet(fleet, recordingJob().job, facts(recordRunEverywhere)),
			);
		} finally {
			for (const unregister of off) unregister();
			host.dispose();
		}

		expect(here.map((one) => one.subagentId)).toEqual(["two"]);
		expect(elsewhere).toEqual([]);
	});

	it("is taken up for a fleet, and only for a fleet", async () => {
		const bus = createEventBus();
		const off = takesUpCarriedFleets(
			bus,
			facts(() => {}),
		);
		try {
			const fleet = await carriedFleet();
			const { job, outcomes } = recordingJob();

			offerCarried(bus, fleet)?.start(job);
			const other: CarriedWork = { kind: "shell", label: "x" };

			expect(offerCarried(bus, other)).toBeUndefined();
			expect(
				offerCarried(bus, { ...fleet, members: "not a list" }),
				"a fleet this version can't read",
			).toBeUndefined();
			await until("the summary", () => outcomes.length === 1);
		} finally {
			off();
		}
	});
});
