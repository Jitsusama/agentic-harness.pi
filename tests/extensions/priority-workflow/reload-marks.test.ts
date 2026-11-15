/**
 * A reload loads the extension again in the same process, where the pid
 * marks' followers live on. The runtime a reload ends lets go of its
 * marks, so a typed mark it held never outlives it, and a key it heard
 * never keeps the next runtime from yielding.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	type EventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	sayBackgroundTurns,
	sayTypedTurns,
} from "../../../extensions/priority-workflow/index.ts";
import { PERSON_TALKED } from "../../../lib/internal/priority/typed.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

let runtime: string;
// The extensions' bus, which a reload keeps: one runtime's listener
// must leave it.
let bus: EventBus;

beforeEach(() => {
	runtime = mkdtempSync(join(tmpdir(), "reload-marks-"));
	bus = createEventBus();
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("SUBAGENT_RUN_ID", "");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(runtime, { recursive: true, force: true });
});

/** One load of the extension's marks, as each reload makes anew. */
function loaded() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: bus,
	} as unknown as Pick<ExtensionAPI, "on" | "events">;
	sayBackgroundTurns(pi, sayTypedTurns(pi));
	let listener: ((data: string) => unknown) | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			getEditorText: () => "",
			onTerminalInput: (handler: (data: string) => unknown) => {
				listener = handler;
				return () => {};
			},
		},
	};
	const fire = async (name: string, event: object = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler({ type: name, ...event }, ctx);
		}
	};
	return { fire, key: (data: string) => listener?.(data) };
}

const marked = (kind: "typed" | "background") =>
	existsSync(join(runtime, "pi", kind, String(process.pid)));

describe("a reload", () => {
	it("takes the typed mark its runtime held, so the next turn nobody typed has none", async () => {
		const before = loaded();
		await before.fire("session_start", { reason: "startup" });
		await before.fire("input", { source: "interactive" });
		await before.fire("agent_start");
		expect(marked("typed"), "a turn the person typed is marked").toBe(true);
		await before.fire("session_shutdown", { reason: "reload" });

		const after = loaded();
		await after.fire("session_start", { reason: "reload" });
		await after.fire("agent_start");
		expect(
			marked("typed"),
			"the runtime the reload ended holds nothing after it",
		).toBe(false);
		await after.fire("session_shutdown", { reason: "quit" });
	});

	it("marks a turn the person's steered words start, until it ends", async () => {
		const one = loaded();
		await one.fire("session_start", { reason: "startup" });
		bus.emit(PERSON_TALKED, {});
		await one.fire("input", { source: "extension" });
		await one.fire("agent_start");
		expect(marked("typed"), "a turn the person steered is marked").toBe(true);
		await one.fire("agent_end");
		expect(marked("typed"), "its end takes the mark").toBe(false);
		await one.fire("session_shutdown", { reason: "quit" });
	});

	it("leaves the next turn unmarked when the words went into a running one", async () => {
		const one = loaded();
		await one.fire("session_start", { reason: "startup" });
		await one.fire("agent_start");
		vi.advanceTimersByTime(1_000);
		bus.emit(PERSON_TALKED, { intoRun: true });
		expect(marked("typed"), "the running turn is marked").toBe(true);
		await one.fire("agent_end");
		await one.fire("agent_start");
		expect(marked("typed"), "the agent's next turn is not").toBe(false);
		await one.fire("session_shutdown", { reason: "quit" });
	});

	it("leaves a talk said after it ended to the runtime after it", async () => {
		const before = loaded();
		await before.fire("session_start", { reason: "startup" });
		await before.fire("session_shutdown", { reason: "reload" });
		bus.emit(PERSON_TALKED, {});
		expect(
			marked("typed"),
			"the ended runtime no longer marks on the bus",
		).toBe(false);
	});

	it("lets the next runtime yield, though its last heard a key", async () => {
		const before = loaded();
		await before.fire("session_start", { reason: "startup" });
		await before.fire("agent_start");
		before.key("a");
		await before.fire("session_shutdown", { reason: "reload" });

		const after = loaded();
		await after.fire("session_start", { reason: "reload" });
		await after.fire("agent_start");
		await vi.advanceTimersByTimeAsync(65_000);
		expect(
			marked("background"),
			"a key the ended runtime heard holds no one back",
		).toBe(true);
		await after.fire("session_shutdown", { reason: "quit" });
		expect(marked("background"), "the last one's end takes it").toBe(false);
	});
});
