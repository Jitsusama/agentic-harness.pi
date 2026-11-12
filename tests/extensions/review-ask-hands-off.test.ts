/**
 * A review round still running after a minute moves to a job.
 *
 * A council holds its turn for minutes: on 11 November 67 review_ask
 * calls held theirs past a minute, at the median for nearly five, deaf
 * to the person and the mesh all that time. So one still going then is
 * handed to the job host, which says how it ended once it has.
 */

import type {
	AgentToolResult,
	EventBus,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskTool } from "../../extensions/review-integration/tools/ask-tool.ts";
import {
	announceJobHost,
	type JobOutcome,
	type JobSpec,
} from "../../lib/jobs/host.ts";
import { until } from "../support/until.ts";

/** The round the tool is answering in a test, ended by the test. */
const round = vi.hoisted(() => ({
	end: (_text: string): void => undefined,
	seen: undefined as AbortSignal | undefined,
}));

// The round's whole answer, swapped for one the test ends, so what is
// tried is only how long the call holds its turn.
vi.mock(
	"../../extensions/review-integration/progress.ts",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../extensions/review-integration/progress.ts")
		>()),
		answerWatching: (_ctx: unknown, signal: AbortSignal | undefined) =>
			new Promise<AgentToolResult<unknown>>((resolve) => {
				round.seen = signal;
				round.end = (text) =>
					resolve({ content: [{ type: "text", text }], details: undefined });
			}),
	}),
);

/**
 * How long a handed-off round's job gets to end. Short of the test's own
 * timeout, so a job that never ends fails naming what was waited on.
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
	round.seen = undefined;
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
		on: () => undefined,
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
	};
	registerAskTool(pi as unknown as ExtensionAPI);
});

afterEach(() => {
	vi.useRealTimers();
	for (const dispose of disposers.splice(0)) dispose();
});

/** Ask for a council on a change, in a session of the given mode. */
function council(mode = "interactive") {
	if (!tool) throw new Error("review_ask was not registered");
	return tool.execute(
		"call-1",
		{ action: "council", change: "shop/app#7" },
		undefined,
		undefined,
		{ mode, sessionManager: { getSessionId: () => "s1" } } as never,
	);
}

const textOf = (result: AgentToolResult<unknown>): string =>
	result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");

describe("a council", () => {
	it("that ends in time answers with its own result and starts no job", async () => {
		const answer = council();
		await until("the round to start", () => round.seen !== undefined);
		round.end("3 findings");
		expect(textOf(await answer)).toBe("3 findings");
		expect(specs, "no job for a round that ended in time").toEqual([]);
	});

	it("still running after a minute moves to a job, which says how it ended", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = council();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(textOf(await answer)).toContain("now runs as background round j1");
		expect(specs).toEqual([
			{ kind: "review", label: "council on shop/app#7", toolCallId: "call-1" },
		]);
		vi.useRealTimers();
		round.end("3 findings");
		await until("the job to finish", () => outcomes.length > 0, ENDS_WITHIN_MS);
		expect(outcomes[0]?.summary).toContain("3 findings");
	});

	it("never moves in a run that ends with its prompts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const answer = council("json");
		await vi.advanceTimersByTimeAsync(120_000);
		round.end("3 findings");
		expect(textOf(await answer)).toBe("3 findings");
		expect(specs, "nobody would hear a job's result").toEqual([]);
	});
});
