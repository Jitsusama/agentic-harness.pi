import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The advisor reviews a substantive turn with a second model, which
 * can take a minute. It used to do that inside turn_end, which the
 * agent loop awaits, so every reviewed turn held the next model call
 * back for as long as the review took, and Escape could not end it:
 * the review answered only to its own clock.
 */

/** What each review was handed, so a test can watch its signal. */
const reviews: { signal: AbortSignal }[] = [];

vi.mock("../../../lib/completion/index.ts", () => ({
	// A review that runs until it is stopped, like a model that stalls.
	runInvestigation: vi.fn(
		(_registry: unknown, options: { signal: AbortSignal }) =>
			new Promise((resolve) => {
				reviews.push({ signal: options.signal });
				options.signal.addEventListener("abort", () =>
					resolve({
						ok: false,
						text: "",
						messages: [],
						error: "stopped",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {},
						},
					}),
				);
			}),
	),
}));

vi.mock("@jitsusama/agentic-harness.core/advisor", async (original) => ({
	...(await original<object>()),
	loadAdvisorEnabled: () => true,
	isSubstantiveTurn: () => true,
}));

vi.mock("@jitsusama/agentic-harness.core/observability", async (original) => ({
	...(await original<object>()),
	recordRunEverywhere: vi.fn(),
}));

vi.mock("../../../lib/internal/transcript.ts", () => ({
	entriesToTurns: () => [{ text: "edited a file" }],
}));

let dir: string;

vi.mock("../../../lib/internal/paths.ts", async (original) => ({
	...(await original<object>()),
	dataDir: (slug: string) => join(dir, slug),
}));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** The advisor's event handlers, as the extension registered them. */
async function loadAdvisor(): Promise<Map<string, Handler>> {
	const handlers = new Map<string, Handler>();
	const { default: advisor } = await import(
		"../../../extensions/advisor/index.ts"
	);
	advisor({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool() {},
		events: { on() {}, emit() {} },
	} as never);
	return handlers;
}

/** A turn's context, owned by a run that `run` can stop. */
function turnContext(run: AbortController): unknown {
	return {
		cwd: dir,
		model: undefined,
		modelRegistry: {},
		signal: run.signal,
		sessionManager: { getEntries: () => [{ type: "message" }] },
		sendMessage() {},
		sendUserMessage() {},
	};
}

/** Longer than a turn_end that does not wait on the review takes. */
const STILL_RUNNING_MS = 500;

/** Whether a promise settled in time, or was still running. */
function settled(work: Promise<unknown>): Promise<string> {
	return Promise.race([
		work.then(() => "returned"),
		new Promise<string>((resolve) =>
			setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
		),
	]);
}

/** Until the review under way has been handed to the model. */
async function reviewStarted(count: number): Promise<void> {
	const deadline = Date.now() + 2000;
	while (reviews.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "advisor-"));
	reviews.length = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("the advisor at the end of a turn", () => {
	it("lets the turn go on while its review runs", async () => {
		const handlers = await loadAdvisor();
		const run = new AbortController();
		await handlers.get("session_start")?.({}, turnContext(run));

		const turnEnd = handlers.get("turn_end")?.({}, turnContext(run));
		await reviewStarted(1);

		expect(reviews).toHaveLength(1);
		expect(await settled(turnEnd ?? Promise.resolve())).toBe("returned");
		run.abort();
	});

	it("stops its review when the run it watched is stopped", async () => {
		const handlers = await loadAdvisor();
		const run = new AbortController();
		await handlers.get("session_start")?.({}, turnContext(run));

		void handlers.get("turn_end")?.({}, turnContext(run));
		await reviewStarted(1);
		run.abort();

		expect(reviews[0]?.signal.aborted).toBe(true);
	});

	it("still runs one review at a time", async () => {
		const handlers = await loadAdvisor();
		const run = new AbortController();
		await handlers.get("session_start")?.({}, turnContext(run));

		void handlers.get("turn_end")?.({}, turnContext(run));
		await reviewStarted(1);
		void handlers.get("turn_end")?.({}, turnContext(run));
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(reviews).toHaveLength(1);
		run.abort();
	});
});
