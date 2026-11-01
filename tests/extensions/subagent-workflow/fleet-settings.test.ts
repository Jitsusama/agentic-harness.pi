/**
 * The subagent tool filling in what its jobs run on, end to end.
 *
 * Driven through the registered tool with the runner stubbed, so what
 * is checked is what a child would actually be started with: the
 * `--model` and `--thinking` pi is handed, the cap the config sets, and
 * the line the answer opens with.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPi } from "../../../lib/subagent/subagent.ts";
import { activateWith } from "../support/review-extension.ts";

const started: string[][] = [];

vi.mock("../../../lib/subagent/runpi/supervisor.ts", () => ({
	createSupervisorRunPi: (): RunPi => async (input) => {
		started.push([...input.args]);
		return { exitCode: 0, finalAssistantText: "done", warnings: [] };
	},
}));

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fleet-settings-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	started.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** Write the package config's `subagent` section. */
function configure(section: unknown): void {
	const dir = join(root, "config", "pi", "agentic-harness.pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ version: 1, sections: { subagent: section } }),
	);
}

/** The flag's value in a child's arguments. */
function flag(args: string[] | undefined, name: string): string | undefined {
	if (!args) return undefined;
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
}

/** Run a fleet, after the person has typed `typed`, when given. */
async function fleet(params: Record<string, unknown>, typed?: string) {
	const stub = activateWith(
		(await import("../../../extensions/subagent-workflow/index.ts")).default,
	);
	if (typed !== undefined) {
		stub.lifecycle.get("input")?.(
			{ type: "input", text: typed, source: "interactive" },
			{},
		);
	}
	const tool = stub.definitions.get("subagent");
	if (!tool) throw new Error("no subagent tool was registered");
	const answer = (await tool.execute("c", params, undefined, undefined, {
		hasUI: false,
		cwd: root,
		model: { provider: "anthropic", id: "claude-opus-5-5" },
	})) as { content: { text: string }[] };
	return answer.content[0]?.text ?? "";
}

const job = (id: string, extra: object = {}) => ({
	id,
	cwd: root,
	userPrompt: "go",
	...extra,
});

describe("a fleet whose jobs name no model", () => {
	it("starts each child on the session's model at high thinking", async () => {
		const text = await fleet({ runId: "f1", jobs: [job("a"), job("b")] });

		expect(started.map((args) => flag(args, "--model"))).toEqual([
			"anthropic/claude-opus-5-5",
			"anthropic/claude-opus-5-5",
		]);
		expect(started.map((args) => flag(args, "--thinking"))).toEqual([
			"high",
			"high",
		]);
		expect(text).toMatch(
			/^Ran on anthropic\/claude-opus-5-5 \(the session's model\) at high thinking \(the default\)\./,
		);
	});

	it("takes the run's defaults before the config's", async () => {
		configure({ defaults: { model: "openai/gpt-5.5", thinkingLevel: "low" } });
		await fleet(
			{
				runId: "f2",
				defaults: { model: "anthropic/claude-sonnet-5" },
				jobs: [job("a")],
			},
			"run this one on sonnet",
		);
		expect(flag(started[0], "--model")).toBe("anthropic/claude-sonnet-5");
		expect(flag(started[0], "--thinking")).toBe("low");
	});

	it("runs on the model the config names, which is the person's to set", async () => {
		configure({ defaults: { model: "openai/gpt-5.5" } });
		await fleet({ runId: "f5", jobs: [job("a")] });
		expect(flag(started[0], "--model")).toBe("openai/gpt-5.5");
	});
});

describe("a fleet naming another model than its usual one", () => {
	it("is refused before anything starts, on a job or the run's defaults", async () => {
		const onJob = await fleet({
			runId: "f6",
			jobs: [job("a"), job("b", { model: "openai/gpt-5.5" })],
		});
		expect(onJob).toContain("Job b: openai/gpt-5.5 is refused");
		const onRun = await fleet(
			{
				runId: "f7",
				defaults: { model: "google/gemini-3-pro" },
				jobs: [job("a")],
			},
			"get a few angles on this",
		);
		expect(onRun).toContain("google/gemini-3-pro is refused");
		expect(onRun).toContain("anthropic/claude-opus-5-5");
		expect(started).toEqual([]);
	});

	it("runs on it when the person asked for it by name", async () => {
		await fleet(
			{ runId: "f8", jobs: [job("a", { model: "openai/gpt-5.5" })] },
			"have GPT take a pass too",
		);
		expect(flag(started[0], "--model")).toBe("openai/gpt-5.5");
	});

	it("runs when the job names the usual model itself", async () => {
		await fleet({
			runId: "f9",
			jobs: [job("a", { model: "anthropic/claude-opus-5-5" })],
		});
		expect(flag(started[0], "--model")).toBe("anthropic/claude-opus-5-5");
	});
});

describe("a fleet past the cap", () => {
	it("is refused before anything starts", async () => {
		configure({ maxJobs: 2 });
		const text = await fleet({
			runId: "f3",
			jobs: [job("a"), job("b"), job("c")],
		});
		expect(text).toContain("the most a fleet may run is 2");
		expect(started).toEqual([]);
	});
});

describe("a config that is wrong", () => {
	it("is refused rather than half-read", async () => {
		configure({ defaults: { thinkingLevel: "ultra" } });
		const text = await fleet({ runId: "f4", jobs: [job("a")] });
		expect(text).toContain("subagent.defaults.thinkingLevel");
		expect(started).toEqual([]);
	});
});
