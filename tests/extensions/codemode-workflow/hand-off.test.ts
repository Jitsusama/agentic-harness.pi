/**
 * The registered `codemode` is pi's own, with its wait cut to a minute:
 * a script still running then moves to a job, and one that ends first
 * answers as it always did.
 */

import type {
	AgentToolResult,
	EventBus,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codemodeWorkflow, {
	scriptLabel,
} from "../../../extensions/codemode-workflow/index.ts";
import {
	announceJobHost,
	type JobOutcome,
	type JobSpec,
} from "../../../lib/jobs/host.ts";
import { until } from "../../support/until.ts";

/** The script pi's codemode is running in a test, ended by the test. */
const script = vi.hoisted(() => ({
	end: (_text: string, _image?: boolean): void => undefined,
	seen: undefined as AbortSignal | undefined,
}));

// pi's codemode with its sandbox swapped for a script the test ends, so
// its shape (name, exposure, loadout, rendering) is pi's real one. The
// script answers as pi's does: a header, then what the script said, each
// image it showed its own block.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const pi =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...pi,
		createCodemodeExtension:
			() => (api: { registerTool: (tool: ToolDefinition) => void }) =>
				pi.createCodemodeExtension()({
					...api,
					registerTool: (tool: ToolDefinition) =>
						api.registerTool({
							...tool,
							execute: (_id, _params, signal) =>
								new Promise<AgentToolResult<unknown>>((resolve) => {
									script.seen = signal;
									script.end = (text, image) =>
										resolve({
											content: [
												{
													type: "text",
													text: "Script completed\nWall time 1 seconds\nOutput:\n",
												},
												{ type: "text", text },
												...(image === true
													? [
															{
																type: "image" as const,
																data: "",
																mimeType: "image/png",
															},
														]
													: []),
											],
											details: undefined,
										});
								}),
						}),
				} as unknown as ExtensionAPI),
	};
});

/**
 * How long a handed-off script's job gets to end. Short of the test's
 * own timeout, so a job that never ends fails naming what was waited on.
 */
const ENDS_WITHIN_MS = 2_000;

let bus: EventBus;
let tool: ToolDefinition | undefined;
let specs: JobSpec[];
let outcomes: JobOutcome[];
const disposers: (() => void)[] = [];

beforeEach(() => {
	vi.useRealTimers();
	bus = createEventBus();
	specs = [];
	outcomes = [];
	tool = undefined;
	script.seen = undefined;
	disposers.push(
		announceJobHost(bus, {
			start(spec) {
				specs.push(spec);
				return {
					id: `j${specs.length}`,
					signal: new AbortController().signal,
					finish: (outcome) => outcomes.push(outcome),
					onDelivered: () => undefined,
					withdraw: () => false,
				};
			},
		}),
	);
	const pi = {
		events: bus,
		getSettings: () => ({}),
		getAllTools: () => [],
		appendEntry: () => undefined,
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	};
	codemodeWorkflow(pi as unknown as ExtensionAPI);
});

afterEach(() => {
	vi.useRealTimers();
	for (const dispose of disposers.splice(0)) dispose();
});

/** Run the registered codemode on a script, in a session of the given mode. */
function run(code: string, mode = "interactive") {
	if (!tool) throw new Error("codemode-workflow registered no tool");
	return tool.execute("call-1", { code }, undefined, undefined, {
		mode,
		sessionManager: { getSessionId: () => "s1" },
	} as never);
}

const textOf = (result: AgentToolResult<unknown>): string =>
	result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");

describe("the registered codemode", () => {
	it("is pi's own, by name, exposure and loadout", () => {
		expect(tool?.name, "it registers under codemode's own name").toBe(
			"codemode",
		);
		expect(tool?.exposure, "scripts still can't start scripts").toBe(
			"model-only",
		);
		expect(
			typeof tool?.prepareLoadout,
			"it keeps pi's loadout, which lists the callable tools",
		).toBe("function");
	});

	it("tells the model a long script moves on, rather than to loop", () => {
		expect(tool?.promptGuidelines?.at(-1)).toContain("moves to the background");
	});
});

describe("a script", () => {
	it("that ends in time answers with its own result and starts no job", async () => {
		const answer = run("return 1");
		await until("the script to start", () => script.seen !== undefined);
		script.end("1");
		expect(textOf(await answer)).toContain("Output:\n1");
		expect(specs, "no job for a script that ended in time").toEqual([]);
	});

	it("still running after a minute moves to a job, which says how it ended", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = run("// @options: {}\nawait tools.bash({command: 'x'})");
		await vi.advanceTimersByTimeAsync(60_000);
		const said = textOf(await answer);
		expect(said).toContain("now runs as background script j1");
		expect(specs).toEqual([
			{
				kind: "codemode",
				label: "await tools.bash({command: 'x'})",
				toolCallId: "call-1",
			},
		]);
		vi.useRealTimers();
		script.end("done");
		await until("the job to finish", () => outcomes.length > 0, ENDS_WITHIN_MS);
		expect(outcomes[0]?.summary).toContain("finished after");
		expect(
			outcomes[0]?.summary,
			"the job says what the script said, not only pi's header",
		).toContain("Output:\ndone");
	});

	it("that moved says an image it showed is left out of its result", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = run("image(shot)");
		await vi.advanceTimersByTimeAsync(60_000);
		await answer;
		vi.useRealTimers();
		script.end("shot taken", true);
		await until("the job to finish", () => outcomes.length > 0, ENDS_WITHIN_MS);
		expect(outcomes[0]?.summary).toContain("shot taken");
		expect(outcomes[0]?.summary).toContain("1 image");
	});

	it("never moves in a run that ends with its prompts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = run("return 2", "json");
		await vi.advanceTimersByTimeAsync(120_000);
		script.end("2");
		expect(textOf(await answer)).toContain("Output:\n2");
		expect(specs, "nobody would hear a job's result").toEqual([]);
	});
});

describe("a script's label", () => {
	it("is its first line that says something, past its options", () => {
		expect(scriptLabel("// @options: {}\n\nconst a = 1;\nreturn a;")).toBe(
			"const a = 1;",
		);
	});

	it("is cut to one short line", () => {
		expect(scriptLabel(`return "${"x".repeat(80)}"`)).toHaveLength(60);
	});
});
