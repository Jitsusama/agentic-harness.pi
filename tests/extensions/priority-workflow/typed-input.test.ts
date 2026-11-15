/**
 * Only what a person typed marks a turn as typed. On 14 November, after
 * Joel's reboot, Reopen Them All started each session with its automated
 * first prompt on pi's command line, which pi hands on as interactive
 * input. Those turns were marked, so the shaper sent 822 MB of autonomous
 * work ahead of everything in 24 minutes, against 446 MB in bulk
 * (B8RBNW [5ae88f12]).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sayTypedTurns } from "../../../extensions/priority-workflow/index.ts";
import { automatedText } from "../../../lib/internal/automated.ts";

type Handler = (event: unknown) => Promise<void>;

let runtime: string;

beforeEach(() => {
	runtime = mkdtempSync(join(tmpdir(), "typed-input-"));
	vi.stubEnv("XDG_RUNTIME_DIR", runtime);
	vi.stubEnv("SUBAGENT_RUN_ID", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(runtime, { recursive: true, force: true });
});

/** The extension's typed marks, and a way to raise pi's events at them. */
function loaded() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: { on: () => () => {} },
	} as unknown as Pick<ExtensionAPI, "on">;
	sayTypedTurns(pi);
	return async (name: string, event: object = {}) => {
		for (const handler of handlers.get(name) ?? [])
			await handler({ type: name, ...event });
	};
}

const marked = () =>
	existsSync(join(runtime, "pi", "typed", String(process.pid)));

describe("a turn's opening input", () => {
	it("marks the turn when the person typed it", async () => {
		const fire = loaded();
		await fire("input", { source: "interactive", text: "fix the bar" });
		await fire("agent_start");

		expect(marked(), "a typed turn is marked").toBe(true);
		await fire("session_shutdown");
	});

	it("leaves a turn the harness started unmarked, though pi calls it interactive", async () => {
		const fire = loaded();
		const reopened = automatedText(
			"the machine restarted, and Reopen Them All reopened this session",
			"Carry on from where you left off.",
		);
		await fire("input", { source: "interactive", text: reopened });
		await fire("agent_start");

		expect(marked(), "an automated prompt is not the person's").toBe(false);
		await fire("session_shutdown");
	});
});
