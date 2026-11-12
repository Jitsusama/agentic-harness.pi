import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

/** Write an extension whose turn_end handler says its name, or fails. */
function extension(name: string, fails = false): string {
	const file = join(base, `${name}.ts`);
	const body = fails
		? `throw new Error("${name} failed");`
		: `pi.events.emit("${HEARD}", "${name}");`;
	writeFileSync(
		file,
		[
			`import { onTurnEnd } from ${JSON.stringify(MODULE)};`,
			"export default function (pi) {",
			`\tonTurnEnd(pi, () => { ${body} });`,
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

/** End one turn, saying who heard it and how often pi built the context. */
async function endTurn(runner: ExtensionRunner, bus: EventBus) {
	const heard: string[] = [];
	const stop = bus.on(HEARD, (name) => {
		heard.push(String(name));
	});
	let builds = 0;
	await runner.emitBoundary(turn, () => {
		builds++;
		return {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		};
	});
	stop();
	return { heard, builds };
}

const NINE = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

describe("one turn_end listener", () => {
	it("hands nine extensions' turn to each while pi builds the context twice", async () => {
		const bus = createEventBus();
		const { runner } = await session(
			NINE.map((name) => extension(name)),
			bus,
		);

		const { heard, builds } = await endTurn(runner, bus);

		expect(heard, "every handler hears the turn, in load order").toEqual(NINE);
		expect(builds, "pi builds before the listener and after it").toBe(2);
	});

	it("still hands the turn on past a handler that fails, and says so", async () => {
		const bus = createEventBus();
		const { runner, errors } = await session(
			[extension("a"), extension("b", true), extension("c")],
			bus,
		);

		const { heard } = await endTurn(runner, bus);

		expect(heard, "the handlers after the failure hear it").toEqual(["a", "c"]);
		expect(errors, "pi reports the failure").toEqual(["b failed"]);
	});

	it("gathers a reload's handlers afresh rather than into the runtime it replaced", async () => {
		const bus = createEventBus();
		const before = await session([extension("a"), extension("b")], bus);
		before.runtime.invalidate();

		const after = await session([extension("c"), extension("d")], bus);
		const { heard, builds } = await endTurn(after.runner, bus);

		expect(heard, "the reloaded extensions hear the turn").toEqual(["c", "d"]);
		expect(builds, "one listener again after the reload").toBe(2);
	});

	it("listens itself where the stand-in has no bus", () => {
		const registered: string[] = [];
		const handler: TurnEndHandler = () => {};
		const pi = {
			on(event: string, given: unknown) {
				if (given === handler) registered.push(event);
			},
		};

		onTurnEnd(pi as never, handler);

		expect(registered, "the handler is pi's own listener").toEqual([
			"turn_end",
		]);
	});
});
