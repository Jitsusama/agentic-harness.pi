/**
 * A run's record says what its supervisor keeps for each member, under
 * the session that started it, as the mesh's node serves it.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerArtifactsStore } from "../../../lib/subagent/artifacts.ts";
import {
	KEPT_MS,
	type RunAsked,
	runRecord,
	watchRun,
	writeRunRecord,
} from "../../../lib/subagent/run-record.ts";

let root: string;
let artifacts: string;
let records: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "run-record-"));
	artifacts = join(root, "artifacts");
	records = join(root, "runs");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const asked = (runId = "fleet-a"): RunAsked => ({
	store: "fleet",
	artifacts,
	runId,
	kind: "fleet",
	parent: "01a1b240-2928-74b2-80e2-553612fecd1a",
	about: runId,
	since: new Date("2026-11-07T04:00:00.000Z"),
});

/** Write one of a member's files as its supervisor would. */
function keep(
	member: string,
	file: "request" | "lease" | "result",
	body: unknown,
	runId = "fleet-a",
): void {
	const paths = new ReviewerArtifactsStore(artifacts).paths(runId, member);
	const path = {
		request: paths.requestPath,
		lease: paths.leasePath,
		result: paths.resultPath,
	}[file];
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(body));
}

function answered(member: string, runId = "fleet-a"): void {
	keep(
		member,
		"result",
		{
			state: "complete",
			completedAt: "2026-11-07T04:10:00.000Z",
			usage: {
				tokens: {
					input: 234,
					output: 80671,
					cacheRead: 18102806,
					cacheWrite: 236528,
					total: 18420239,
				},
				cost: { total: 7.1271412 },
			},
		},
		runId,
	);
}

/** The one run a record file holds, as the node reads it. */
function recordIn(name: string): Record<string, unknown> {
	const body = JSON.parse(readFileSync(join(records, name), "utf8"));
	expect(body).toEqual({ v: 1, runs: [expect.any(Object)] });
	return body.runs[0];
}

describe("a run's record", () => {
	it("says each member as its supervisor's files say it", async () => {
		keep("asked", "request", {
			args: ["--mode", "json", "--model", "anthropic/claude-opus-5-5"],
		});
		keep("answered", "lease", {
			state: "complete",
			supervisorStartedAt: Date.parse("2026-11-07T04:00:01.000Z"),
		});
		answered("answered");

		const record = await runRecord(
			asked(),
			[
				{ id: "asked" },
				{ id: "answered", persona: "security" },
				{ id: "queued", model: "anthropic/claude-opus-5-5" },
			],
			new Date("2026-11-07T04:11:00.000Z"),
		);

		const paths = new ReviewerArtifactsStore(artifacts);
		expect(record).toEqual({
			id: "fleet.fleet-a",
			kind: "fleet",
			"run.kind": "fleet",
			parent: "01a1b240-2928-74b2-80e2-553612fecd1a",
			about: "fleet-a",
			state: "running",
			since: "2026-11-07T04:00:00.000Z",
			at: "2026-11-07T04:11:00.000Z",
			members: [
				{
					id: "asked",
					state: "running",
					model: "anthropic/claude-opus-5-5",
					answer: paths.paths("fleet-a", "asked").resultPath,
				},
				{
					id: "answered",
					state: "complete",
					persona: "security",
					answer: paths.paths("fleet-a", "answered").resultPath,
					since: "2026-11-07T04:00:01.000Z",
					ended: "2026-11-07T04:10:00.000Z",
					usage: {
						"gen_ai.usage.input_tokens": 234,
						"gen_ai.usage.output_tokens": 80671,
						"gen_ai.usage.cache_read.input_tokens": 18102806,
						"gen_ai.usage.cache_creation.input_tokens": 236528,
					},
					"pi.cost.usd": 7.1271412,
				},
				{
					id: "queued",
					state: "queued",
					model: "anthropic/claude-opus-5-5",
					answer: paths.paths("fleet-a", "queued").resultPath,
				},
			],
			"pi.cost.usd": 7.1271412,
		});
	});

	it("says how a member ended when its supervisor left only a lease", async () => {
		keep("gone", "lease", {
			state: "supervisor-lost",
			completedAt: "2026-11-07T04:05:00.000Z",
		});

		const record = await runRecord(
			asked(),
			[{ id: "gone" }],
			new Date("2026-11-07T04:06:00.000Z"),
		);

		expect(record.members[0]).toMatchObject({
			state: "supervisor-lost",
			ended: "2026-11-07T04:05:00.000Z",
		});
		expect(record).toMatchObject({
			state: "failed",
			ended: "2026-11-07T04:05:00.000Z",
		});
	});

	it("is stopped when a member was cancelled", async () => {
		answered("one");
		keep("two", "result", {
			state: "cancelled",
			completedAt: "2026-11-07T04:03:00.000Z",
		});

		const record = await runRecord(
			asked(),
			[{ id: "one" }, { id: "two" }],
			new Date(),
		);

		expect(record).toMatchObject({
			state: "stopped",
			ended: "2026-11-07T04:10:00.000Z",
		});
	});
});

describe("watching a run", () => {
	// The watch's clock is the run's own, minutes after it began: on the
	// system's, a run begun on 7 November aged out of the day records are
	// kept from the 8th, and nothing was written.
	const during = () => new Date("2026-11-07T04:20:00.000Z");

	it("says it at once, and how it ended as its call returns", async () => {
		keep("one", "request", { args: [] });
		const watch = watchRun(asked(), [{ id: "one" }, { id: "never" }], {
			dir: records,
			now: during,
		});
		await vi.waitFor(() =>
			expect(recordIn("fleet.fleet-a.json")).toMatchObject({
				state: "running",
			}),
		);

		answered("one");
		await watch.end();

		const record = recordIn("fleet.fleet-a.json");
		expect(record).toMatchObject({ state: "done", ended: expect.any(String) });
		expect(record.members).toEqual([
			expect.objectContaining({ id: "one", state: "complete" }),
			expect.objectContaining({ id: "never", state: "failed" }),
		]);
	});

	it("goes on saying a member still running after its call returns, until it ends", async () => {
		keep("detached", "request", { args: [] });
		const watch = watchRun(asked(), [{ id: "detached" }], {
			dir: records,
			everyMs: 10,
			now: during,
		});
		await watch.end();
		expect(recordIn("fleet.fleet-a.json")).toMatchObject({ state: "running" });

		answered("detached");

		await vi.waitFor(() =>
			expect(recordIn("fleet.fleet-a.json")).toMatchObject({ state: "done" }),
		);
	});

	it("takes in a member asked after it began", async () => {
		const watch = watchRun(asked(), [{ id: "lead" }], {
			dir: records,
			now: during,
		});
		watch.note({ id: "after", persona: "tests" });
		answered("lead");
		answered("after");
		await watch.end();

		expect(recordIn("fleet.fleet-a.json").members).toEqual([
			expect.objectContaining({ id: "lead" }),
			expect.objectContaining({ id: "after", persona: "tests" }),
		]);
	});
});

describe("writing a record", () => {
	it("lets go of runs that ended a day ago, and of runs nobody has said for as long", async () => {
		const now = new Date("2026-11-08T12:00:00.000Z");
		const long = new Date(now.getTime() - KEPT_MS - 1000).toISOString();
		const lately = new Date(now.getTime() - 1000).toISOString();
		const { ended: _never, ...base } = {
			...(await runRecord(asked(), [], now)),
			state: "running" as const,
		};
		await writeRunRecord(
			records,
			{ ...base, id: "fleet.ended-long-ago", state: "done", ended: long },
			now,
		);
		await writeRunRecord(
			records,
			{ ...base, id: "fleet.unsaid-long", at: long },
			now,
		);
		await writeRunRecord(
			records,
			{ ...base, id: "fleet.ended-lately", state: "done", ended: lately },
			now,
		);

		await writeRunRecord(records, { ...base, id: "fleet.now" }, now);

		expect(readdirSync(records).sort()).toEqual([
			"fleet.ended-lately.json",
			"fleet.now.json",
		]);
	});
});
