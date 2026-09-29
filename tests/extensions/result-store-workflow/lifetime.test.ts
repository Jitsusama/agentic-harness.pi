/**
 * How long a stored payload outlives the session that stored it.
 *
 * pi says session_shutdown for a reload, a new session, a resume and
 * a fork as well as for a quit. All but a quit leave this process
 * running, and a reload leaves the conversation on screen citing the
 * handles it was given, so deleting the directory then answered every
 * later query of them with "no such handle".
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionResultDir } from "@jitsusama/agentic-harness.core/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import resultStore from "../../../extensions/result-store-workflow/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Activate the extension and hand back its lifecycle handlers. */
function activate(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		registerTool() {},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	resultStore(pi as never);
	return handlers;
}

const payload = (): string => join(sessionResultDir(), "result-0000.json");

beforeEach(() => {
	mkdirSync(sessionResultDir(), { recursive: true });
	writeFileSync(payload(), "{}");
});

afterEach(() => {
	rmSync(sessionResultDir(), { recursive: true, force: true });
});

describe("a session's stored payloads", () => {
	it.each([
		"reload",
		"new",
		"resume",
		"fork",
	])("are kept through a %s, which leaves this process running", async (reason) => {
		await activate().get("session_shutdown")?.(
			{ type: "session_shutdown", reason },
			{},
		);
		expect(existsSync(payload())).toBe(true);
	});

	it("are removed when pi quits", async () => {
		await activate().get("session_shutdown")?.(
			{ type: "session_shutdown", reason: "quit" },
			{},
		);
		expect(existsSync(payload())).toBe(false);
	});
});
