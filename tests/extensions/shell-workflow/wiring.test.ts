/**
 * The registered `bash` is pi's bash built with the person's settings:
 * a command prefix in settings.json still applies, and the agent's
 * commands still get no editor to wait on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shellWorkflow from "../../../extensions/shell-workflow/index.ts";
import { SANDBOX_VARIABLE } from "../../../lib/internal/sandbox.ts";
import { announceJobHost, type JobSpec } from "../../../lib/jobs/host.ts";

interface Tool {
	name: string;
	promptGuidelines?: string[];
	parameters: { properties: Record<string, unknown> };
	execute: (
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: { type: string; text?: string }[] }>;
}

let agentDir: string;
let saved: string | undefined;
let tool: Tool | undefined;
let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
let bus: EventBus;

beforeEach(() => {
	saved = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "shell-workflow-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Unfenced, whatever runs the tests: these cases are about pi's bash
	// and the person's settings, and a fenced session's sandbox, asked for
	// as the extension loads, can't be had inside its own fence.
	vi.stubEnv(SANDBOX_VARIABLE, "");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ shellCommandPrefix: "export WIRED=yes" }),
	);
	bus = createEventBus();
	const pi = {
		events: bus,
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
	};
	shellWorkflow(pi as unknown as ExtensionAPI);
});

afterEach(() => {
	if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved;
	rmSync(agentDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const ctx = (mode = "tui") => ({
	mode,
	cwd: agentDir,
	isProjectTrusted: () => false,
	// pi's bash names the session to the command it runs.
	sessionManager: {
		getSessionId: () => "session-1",
		getSessionFile: () => undefined,
	},
});

describe("the registered bash", () => {
	it("replaces pi's and offers background", () => {
		expect(tool?.name).toBe("bash");
		expect(Object.keys(tool?.parameters.properties ?? {})).toEqual([
			"command",
			"timeout",
			"background",
		]);
	});

	it("runs with the person's command prefix and no editor", async () => {
		await sessionStart?.({ type: "session_start" }, ctx());
		const result = await tool?.execute(
			"t1",
			{ command: 'printf "%s %s %s" "$WIRED" "$GIT_EDITOR" "$PI_SESSION_ID"' },
			undefined,
			undefined,
			ctx(),
		);

		expect(result?.content[0]?.text).toBe("yes true session-1");
	});

	it("keeps the command, its prefix included, off the shell's command line", async () => {
		await sessionStart?.({ type: "session_start" }, ctx());
		const result = await tool?.execute(
			"t2",
			{ command: "tr '\\0' ' ' < /proc/$$/cmdline" },
			undefined,
			undefined,
			ctx(),
		);

		const shown = result?.content[0]?.text ?? "";
		expect(shown).toContain("eval");
		expect(shown).not.toContain("WIRED");
		expect(shown).not.toContain("cmdline");
	});
});

// 80ECO2's fenced `pi -p` proof on 2026-11-11: a command handed off after
// the minute was killed as the run ended, and its result never came.
describe("a run that ends with its prompts", () => {
	const started: JobSpec[] = [];

	beforeEach(() => {
		started.length = 0;
		announceJobHost(bus, {
			start: (spec) => {
				started.push(spec);
				return {
					id: "j1",
					signal: new AbortController().signal,
					finish: () => undefined,
					onDelivered: () => undefined,
					withdraw: () => false,
				};
			},
		});
	});

	const run = async (mode: string) => {
		await sessionStart?.({ type: "session_start" }, ctx(mode));
		return await tool?.execute(
			"t3",
			{ command: "printf ran", background: true },
			undefined,
			undefined,
			ctx(mode),
		);
	};

	it.each(["print", "json"])(
		"keeps a %s run's command in the call, since its job would die as the run ends",
		async (mode) => {
			const result = await run(mode);

			expect(
				result?.content[0]?.text,
				"the command's own result, not a hand-off",
			).toBe("ran");
			expect(started, "no job was started for it").toEqual([]);
		},
	);

	it("still hands a session's command to a job when the session goes on", async () => {
		const result = await run("tui");

		expect(
			result?.content[0]?.text,
			"the call says the command moved",
		).toContain("background command j1");
		expect(started, "one job holds the command").toHaveLength(1);
	});
});

// 480 of 1,499 queued jobs on record ran under `nice -n`, which in the jobs
// cgroup only ranks a command against other agents' work: a niced VM test
// loses to every build beside it.
describe("telling agents not to add nice", () => {
	let savedCgroup: string | undefined;

	beforeEach(() => {
		savedCgroup = process.env.JOBS_CGROUP;
	});

	afterEach(() => {
		if (savedCgroup === undefined) delete process.env.JOBS_CGROUP;
		else process.env.JOBS_CGROUP = savedCgroup;
	});

	const guidelines = (cgroup: string | undefined): string[] => {
		if (cgroup === undefined) delete process.env.JOBS_CGROUP;
		else process.env.JOBS_CGROUP = cgroup;
		let registered: Tool | undefined;
		shellWorkflow({
			events: createEventBus(),
			on: () => {},
			registerTool: (definition: Tool) => {
				registered = definition;
			},
		} as unknown as ExtensionAPI);
		return registered?.promptGuidelines ?? [];
	};

	it("says so where commands run in the jobs cgroup", () => {
		const said = guidelines("jobs.slice/jobs.service").filter((line) =>
			line.includes("nice"),
		);

		expect(said).toHaveLength(1);
		expect(said[0]).toMatch(/VM test.*every build/s);
	});

	it("says nothing where nice still does what it says", () => {
		expect(
			guidelines(undefined).filter((line) => line.includes("nice")),
		).toEqual([]);
	});
});
