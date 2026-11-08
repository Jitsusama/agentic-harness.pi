/**
 * Which input takes a pi back from the background. A turn nobody typed
 * yields its CPU weight once the person has left it for a minute, and
 * their return takes it back at once; focus leaving the window, or the
 * pointer passing over it, is not their return.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sayBackgroundTurns } from "../../../extensions/priority-workflow/index.ts";
import { FOCUS_IN, FOCUS_OUT } from "../../../lib/ui/terminal-reports.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

let runtime: string;

beforeEach(() => {
	runtime = mkdtempSync(join(tmpdir(), "background-presence-"));
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("SUBAGENT_RUN_ID", "");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(runtime, { recursive: true, force: true });
});

/** A pi in a terminal, working a turn nobody typed, with its input. */
async function working() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as unknown as Pick<ExtensionAPI, "on">;
	sayBackgroundTurns(pi, { held: () => false });
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
	const fire = (name: string) => handlers.get(name)?.({ type: name }, ctx);
	await fire("session_start");
	await fire("agent_start");
	return {
		send: (data: string) => listener?.(data),
		end: () => fire("session_shutdown"),
	};
}

const marked = () =>
	existsSync(join(runtime, "pi", "background", String(process.pid)));

describe("a pi in the background", () => {
	it("stays there when focus leaves or the pointer passes, and leaves it for a key", async () => {
		const { send, end } = await working();
		await vi.advanceTimersByTimeAsync(65_000);
		const yielded = marked();
		send(FOCUS_OUT);
		send("\x1b[<35;10;5M");
		const afterLeaving = marked();
		send("a");
		expect({ yielded, afterLeaving, afterKey: marked() }).toEqual({
			yielded: true,
			afterLeaving: true,
			afterKey: false,
		});
		await end();
	});

	it("leaves it when focus comes back", async () => {
		const { send, end } = await working();
		await vi.advanceTimersByTimeAsync(65_000);
		send(FOCUS_IN);
		expect(marked()).toEqual(false);
		await end();
	});
});
