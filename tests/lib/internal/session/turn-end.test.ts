import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createEventBus,
	discoverAndLoadExtensions,
	type EventBus,
	ExtensionRunner,
	SessionManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	onTurnEnd,
	type TurnEndHandler,
} from "../../../../lib/internal/session/turn-end.ts";

const MODULE = fileURLToPath(
	new URL("../../../../lib/internal/session/turn-end.ts", import.meta.url),
);
const HEARD = "test/turn-end/heard";
/** Where a boundary extension is told whether it wants the boundary. */
const WANTS = "test/turn-end/wants";

const answer: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

function result(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	};
}

/** A turn's end as pi starts it, before any handler proposes. */
type TurnEnd = Omit<TurnEndEvent, "entries" | "continue" | "context">;
const turn: TurnEnd = {
	type: "turn_end",
	turnIndex: 0,
	message: answer,
	toolResults: [],
	messageEntryId: "answer",
	toolResultEntryIds: [],
	outcome: "completed",
};

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "turn-end-"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/**
 * Write an extension whose handler says its name and what it heard, or
 * fails; a boundary one asks for the boundary while WANTS says so.
 */
function extension(
	name: string,
	how: { fails?: boolean; boundary?: boolean } = {},
): string {
	const file = join(base, `${name}.ts`);
	const body = how.fails
		? `throw new Error("${name} failed");`
		: `pi.events.emit("${HEARD}", { name: "${name}", turn: event.turnIndex, results: event.toolResults.length, outcome: event.outcome });`;
	const register = how.boundary
		? [
				"\tlet wants = false;",
				`\tpi.events.on("${WANTS}", (value) => { wants = value === true; });`,
				`\tonTurnBoundary(pi, (event) => { ${body} }, () => wants);`,
			]
		: [`\tonTurnEnd(pi, (event) => { ${body} });`];
	writeFileSync(
		file,
		[
			`import { onTurnBoundary, onTurnEnd } from ${JSON.stringify(MODULE)};`,
			"export default function (pi) {",
			...register,
			"}",
		].join("\n"),
	);
	return file;
}

/** Load the extensions as pi does, on one session's bus, and run them. */
async function session(files: readonly string[], bus: EventBus) {
	const cwd = join(base, "work");
	const agentDir = join(base, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const loaded = await discoverAndLoadExtensions(
		[...files],
		cwd,
		agentDir,
		bus,
	);
	expect(loaded.errors, "every extension loads").toEqual([]);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		SessionManager.inMemory(cwd),
		{} as never,
	);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	return { runner, runtime: loaded.runtime, errors };
}

interface Heard {
	readonly name: string;
	readonly turn: number;
	readonly results: number;
	readonly outcome: string;
}

/**
 * Run one agent run of turns as pi's loop emits them, each turn one
 * assistant answer and that many tool results, saying who heard what
 * and how often pi built the context for a turn_end boundary.
 */
async function run(
	runner: ExtensionRunner,
	bus: EventBus,
	turns: readonly number[],
	stopReason: AssistantMessage["stopReason"] = "stop",
) {
	const heard: Heard[] = [];
	const stop = bus.on(HEARD, (data) => {
		heard.push(data as Heard);
	});
	let builds = 0;
	const build = () => {
		builds++;
		return {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		};
	};
	await runner.emit({ type: "agent_start" });
	for (const [index, results] of turns.entries()) {
		await runner.emit({ type: "turn_start", turnIndex: index, timestamp: 0 });
		const message = { ...answer, stopReason };
		await runner.emitMessageEnd({ type: "message_end", message });
		const toolResults: ToolResultMessage[] = [];
		for (let i = 0; i < results; i++) {
			const one = result(`${index}-${i}`);
			toolResults.push(one);
			await runner.emitMessageEnd({ type: "message_end", message: one });
		}
		// pi dispatches the boundary only where a handler is registered.
		if (runner.hasHandlers("turn_end")) {
			await runner.emitBoundary(
				{ ...turn, turnIndex: index, message, toolResults },
				build,
			);
		}
	}
	await runner.emit({ type: "agent_end", messages: [] });
	stop();
	return { heard, builds };
}

const NINE = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

describe("one listener for the end of a turn", () => {
	it("hands nine extensions' turn to each while pi builds no boundary context", async () => {
		const bus = createEventBus();
		const { runner } = await session(
			NINE.map((name) => extension(name)),
			bus,
		);

		const { heard, builds } = await run(runner, bus, [0]);

		expect(
			heard.map((one) => one.name),
			"every handler hears the turn, in load order",
		).toEqual(NINE);
		expect(builds, "nothing listens on pi's boundary").toBe(0);
	});

	it("hands each turn of a run on with its index and its tool results", async () => {
		const bus = createEventBus();
		const { runner } = await session([extension("a")], bus);

		const { heard } = await run(runner, bus, [2, 1, 0]);

		expect(heard, "each turn once, as it ended").toEqual([
			{ name: "a", turn: 0, results: 2, outcome: "completed" },
			{ name: "a", turn: 1, results: 1, outcome: "completed" },
			{ name: "a", turn: 2, results: 0, outcome: "completed" },
		]);
	});

	it("says a turn that stopped short ended so", async () => {
		const bus = createEventBus();
		const { runner } = await session([extension("a")], bus);

		const { heard } = await run(runner, bus, [0], "aborted");

		expect(
			heard.map((one) => one.outcome),
			"the outcome follows the stop reason",
		).toEqual(["aborted"]);
	});

	it("still hands the turn on past a handler that fails, and says so", async () => {
		const bus = createEventBus();
		const { runner, errors } = await session(
			[extension("a"), extension("b", { fails: true }), extension("c")],
			bus,
		);

		const { heard } = await run(runner, bus, [0]);

		expect(
			heard.map((one) => one.name),
			"the handlers after the failure hear it",
		).toEqual(["a", "c"]);
		expect(errors, "pi reports the failure").toEqual(["b failed"]);
	});

	it("gathers a reload's handlers afresh rather than into the runtime it replaced", async () => {
		const bus = createEventBus();
		const before = await session([extension("a"), extension("b")], bus);
		before.runtime.invalidate();

		const after = await session([extension("c"), extension("d")], bus);
		const { heard } = await run(after.runner, bus, [0]);

		expect(
			heard.map((one) => one.name),
			"the reloaded extensions hear the turn once each",
		).toEqual(["c", "d"]);
	});
});

describe("the boundary, only while one wants it", () => {
	it("costs pi nothing while no boundary handler wants it", async () => {
		const bus = createEventBus();
		const { runner } = await session(
			[extension("a"), extension("v", { boundary: true })],
			bus,
		);

		const { heard, builds } = await run(runner, bus, [1, 0]);

		expect(
			heard.map((one) => one.name),
			"only the observer hears",
		).toEqual(["a", "a"]);
		expect(builds, "no boundary is dispatched").toBe(0);
	});

	it("listens on the boundary while wanted, two builds a turn, and lets go after", async () => {
		const bus = createEventBus();
		const { runner } = await session(
			[extension("a"), extension("v", { boundary: true })],
			bus,
		);

		bus.emit(WANTS, true);
		const wanted = await run(runner, bus, [0]);
		bus.emit(WANTS, false);
		const after = await run(runner, bus, [0]);

		expect(
			wanted.heard.map((one) => one.name),
			"the boundary handler hears it at the boundary, the observer after",
		).toEqual(["v", "a"]);
		expect(wanted.builds, "pi builds before the listener and after it").toBe(2);
		expect(after.builds, "the boundary is let go").toBe(0);
		expect(
			after.heard.map((one) => one.name),
			"the observer still hears",
		).toEqual(["a"]);
	});
});

describe("without a bus", () => {
	it("listens itself where the stand-in has no bus", () => {
		const registered: string[] = [];
		const handler: TurnEndHandler = () => {};
		const pi = {
			on(event: string) {
				registered.push(event);
			},
		};

		onTurnEnd(pi as never, handler);

		expect(registered, "it hears turns off pi's boundary").not.toContain(
			"turn_end",
		);
		expect(registered, "it hears a turn's messages and its end").toEqual(
			expect.arrayContaining(["message_end", "turn_start", "agent_end"]),
		);
	});
});
