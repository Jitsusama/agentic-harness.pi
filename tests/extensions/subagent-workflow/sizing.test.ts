/**
 * What a fleet's jobs run on, and how many a fleet may have.
 *
 * A job that named no model ran on pi's `defaultModel`, which on the
 * machine this was written on is a different provider from the
 * session's. Each setting is now filled in layers, first match winning:
 * the job, the run, the quest, the project, the config, then the
 * session's model at high thinking.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_JOBS,
	describeSettled,
	type FleetConfig,
	oversized,
	readFleetConfig,
	readRunDefaults,
	settleJob,
} from "../../../extensions/subagent-workflow/sizing.ts";

const PATH = "~/.config/pi/agentic-harness.pi/config.json";
const SESSION = "anthropic/claude-opus-5-5";

function configOf(section: unknown): FleetConfig {
	const read = readFleetConfig(section, PATH);
	if (!read.ok) throw new Error(read.error);
	return read.config;
}

describe("a job that names nothing", () => {
	it("runs on the session's model at high thinking", () => {
		expect(
			settleJob({}, configOf(undefined), { sessionModel: SESSION }),
		).toEqual({
			model: SESSION,
			modelFrom: "session",
			thinkingLevel: "high",
			thinkingFrom: "built-in",
		});
	});

	it("says so when there is no session model to take", () => {
		const settled = settleJob({}, configOf(undefined), {});
		expect(settled.model).toBeUndefined();
		expect(describeSettled([{ id: "a", settled }])).toContain(
			"pi's defaultModel, since nothing named one",
		);
	});
});

describe("the layers, first match winning", () => {
	const config = configOf({
		defaults: { model: "config/model", thinkingLevel: "low", tools: ["read"] },
		quests: { "QEST-1": { model: "quest/model" } },
		projects: {
			"github:Jitsusama/agentic-harness.pi": {
				model: "project/model",
				thinkingLevel: "medium",
			},
		},
	});
	const project = "github:Jitsusama/agentic-harness.pi";

	it("takes the job's own setting over every layer", () => {
		const settled = settleJob({ model: "job/model" }, config, {
			run: { model: "run/model" },
			quest: "QEST-1",
			project,
			sessionModel: SESSION,
		});
		expect(settled).toMatchObject({ model: "job/model", modelFrom: "job" });
	});

	it("takes the run's defaults over the quest's", () => {
		const settled = settleJob({}, config, {
			run: { model: "run/model" },
			quest: "QEST-1",
		});
		expect(settled).toMatchObject({ model: "run/model", modelFrom: "run" });
	});

	it("takes the quest's over the project's, field by field", () => {
		const settled = settleJob({}, config, { quest: "QEST-1", project });
		expect(settled).toMatchObject({
			model: "quest/model",
			modelFrom: "quest",
			thinkingLevel: "medium",
			thinkingFrom: "project",
			tools: ["read"],
		});
	});

	it("takes the config's defaults over the session's model", () => {
		const settled = settleJob({}, config, { sessionModel: SESSION });
		expect(settled).toMatchObject({
			model: "config/model",
			modelFrom: "config",
			thinkingLevel: "low",
		});
	});

	it("ignores a quest or project the config does not name", () => {
		const settled = settleJob({}, configOf(undefined), {
			quest: "QEST-2",
			project: "github:other/repo",
			sessionModel: SESSION,
		});
		expect(settled.modelFrom).toBe("session");
	});
});

describe("saying what the jobs ran on", () => {
	it("says it once when every job ran on the same", () => {
		const settled = settleJob({}, configOf(undefined), {
			sessionModel: SESSION,
		});
		expect(
			describeSettled([
				{ id: "a", settled },
				{ id: "b", settled },
			]),
		).toBe(
			`Ran on ${SESSION} (the session's model) at high thinking (the default).`,
		);
	});

	it("groups the jobs by what they ran on when they differ", () => {
		const config = configOf(undefined);
		const place = { sessionModel: SESSION };
		expect(
			describeSettled([
				{ id: "a", settled: settleJob({}, config, place) },
				{
					id: "b",
					settled: settleJob({ model: "openai/gpt-5.5" }, config, place),
				},
				{ id: "c", settled: settleJob({}, config, place) },
			]),
		).toBe(
			[
				`a, c: ${SESSION} (the session's model) at high thinking (the default).`,
				"b: openai/gpt-5.5 (set on the job) at high thinking (the default).",
			].join("\n"),
		);
	});
});

describe("the cap", () => {
	it("allows a fleet up to the default size", () => {
		expect(
			oversized(DEFAULT_MAX_JOBS, configOf(undefined), PATH),
		).toBeUndefined();
	});

	it("refuses one past it, saying how to raise it", () => {
		const refusal = oversized(DEFAULT_MAX_JOBS + 1, configOf(undefined), PATH);
		expect(refusal).toContain(
			`the most a fleet may run is ${DEFAULT_MAX_JOBS}`,
		);
		expect(refusal).toContain(`subagent.maxJobs in ${PATH}`);
	});

	it("takes its size from the config", () => {
		expect(oversized(12, configOf({ maxJobs: 12 }), PATH)).toBeUndefined();
		expect(oversized(3, configOf({ maxJobs: 2 }), PATH)).toBeDefined();
	});
});

describe("a config that is there and wrong", () => {
	it.each([
		[{ maxJobs: 0 }, "subagent.maxJobs"],
		[{ maxJobs: "8" }, "subagent.maxJobs"],
		[
			{ defaults: { thinkingLevel: "ultra" } },
			"subagent.defaults.thinkingLevel",
		],
		[{ defaults: { tools: "read" } }, "subagent.defaults.tools"],
		[{ quests: { Q: { model: 5 } } }, "subagent.quests.Q.model"],
		[{ projects: { P: { timeoutMs: 10 } } }, "subagent.projects.P.timeoutMs"],
		[[], "subagent in"],
	])("refuses %j, naming %s", (section, field) => {
		const read = readFleetConfig(section, PATH);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error).toContain(field);
	});

	it("holds a run's own defaults to the same rules", () => {
		expect(readRunDefaults({ thinkingLevel: "ultra" })).toEqual({
			error: "defaults.thinkingLevel must be a level pi takes",
		});
	});
});
