import {
	clearLspBackends,
	type Diagnostic,
	type LspBackend,
	registerLspBackend,
} from "@jitsusama/agentic-harness.core/lsp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import verificationWorkflow from "../../../extensions/verification-workflow/index.ts";
import { FAST_LAYER_WALL_MS } from "../../../extensions/verification-workflow/state.ts";

/**
 * What the fast layer does when the language server will not answer.
 *
 * It checks the touched files inside turn_end, which the loop awaits
 * before it hands the turn back, on purpose: a fix request has to be
 * queued before the loop drains its follow-ups. So a server that never
 * answers held the turn for good, and Escape could not end it, since
 * the calls were handed no signal.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface Harness {
	readonly handlers: Map<string, Handler>;
	readonly sendUserMessage: ReturnType<typeof vi.fn>;
	readonly statuses: Array<string | undefined>;
}

/** The workflow's handlers and what it said, as a fake pi saw them. */
function harness(): Harness {
	const handlers = new Map<string, Handler>();
	const sendUserMessage = vi.fn();
	verificationWorkflow({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool() {},
		sendUserMessage,
		events: { on() {}, emit() {} },
	} as never);
	return { handlers, sendUserMessage, statuses: [] };
}

/** A turn's context, owned by a run that `run` can stop. */
function turnContext(h: Harness, run: AbortController): unknown {
	return {
		signal: run.signal,
		sessionManager: { getEntries: () => [] },
		ui: {
			theme: { fg: (colour: string, text: string) => `${colour}:${text}` },
			setStatus: (_key: string, label: string | undefined) =>
				h.statuses.push(label),
		},
	};
}

/** A backend whose diagnostics come from `answer`, keeping each signal. */
function backend(
	handed: Array<AbortSignal | undefined>,
	answer: () => Promise<readonly Diagnostic[]>,
): LspBackend {
	const never = (): Promise<never> => new Promise(() => {});
	return {
		name: "test",
		diagnostics: (_path, options) => {
			handed.push(options?.signal);
			return answer();
		},
		definition: never,
		references: never,
		hover: never,
		documentSymbols: never,
		workspaceSymbols: never,
		rename: never,
		codeActions: never,
		dispose: async () => {},
	};
}

/** Edit files, then end a turn that is about to yield. */
async function endTurnAfterAnEdit(
	h: Harness,
	run: AbortController,
	paths: readonly string[] = ["/work/a.ts"],
): Promise<{ settled: () => boolean; done: Promise<unknown> }> {
	for (const path of paths) {
		await h.handlers.get("tool_result")?.(
			{ toolName: "edit", isError: false, input: { path } },
			turnContext(h, run),
		);
	}
	let finished = false;
	const done = (
		h.handlers.get("turn_end")?.(
			{ message: { stopReason: "stop" }, toolResults: [] },
			turnContext(h, run),
		) ?? Promise.resolve()
	).finally(() => {
		finished = true;
	});
	return { settled: () => finished, done };
}

let handed: Array<AbortSignal | undefined>;

const anError = {
	severity: "error",
	message: "no such name",
	range: { start: { line: 3, character: 1 }, end: { line: 3, character: 4 } },
} as unknown as Diagnostic;

function serve(answer: () => Promise<readonly Diagnostic[]>): void {
	clearLspBackends();
	registerLspBackend({
		name: "test",
		priority: 1,
		isAvailable: () => true,
		backend: backend(handed, answer),
	});
}

beforeEach(() => {
	handed = [];
});

afterEach(() => {
	clearLspBackends();
	vi.useRealTimers();
});

describe("the fast layer at the end of a turn", () => {
	it("gives up on a server that never answers once its clock runs out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		serve(() => new Promise(() => {}));
		const h = harness();
		const turn = await endTurnAfterAnEdit(h, new AbortController());
		turn.done.catch(() => {});

		await vi.advanceTimersByTimeAsync(FAST_LAYER_WALL_MS + 100);

		expect(turn.settled()).toBe(true);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		expect(h.statuses.at(-1)).toBe("muted:verify (tdd)");
	});

	it("stops asking the server when the run is stopped", async () => {
		serve(() => new Promise(() => {}));
		const h = harness();
		const run = new AbortController();
		const turn = await endTurnAfterAnEdit(h, run);

		run.abort();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(turn.settled()).toBe(true);
		expect(handed[0]?.aborted).toBe(true);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("asks for no fix once the run is stopped, even with errors found", async () => {
		// The first file answers with an error, and the second never does.
		let asked = 0;
		serve(() =>
			asked++ === 0 ? Promise.resolve([anError]) : new Promise(() => {}),
		);
		const h = harness();
		const run = new AbortController();
		const turn = await endTurnAfterAnEdit(h, run, ["/work/a.ts", "/work/b.ts"]);
		while (handed.length < 2)
			await new Promise((resolve) => setTimeout(resolve, 5));

		run.abort();
		await turn.done;

		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("still asks for a fix when the server reports an error", async () => {
		serve(async () => [anError]);
		const h = harness();
		const turn = await endTurnAfterAnEdit(h, new AbortController());
		await turn.done;

		expect(h.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
			deliverAs: "followUp",
		});
	});
});
