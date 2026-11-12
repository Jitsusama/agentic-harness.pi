/**
 * A line typed while a long call runs, in real pi.
 *
 * pi reads such a line only once every call of the turn has ended, and on
 * 11 November lines waited up to 101.6 s behind one. Typed now, the
 * working line says at once what the line waits on, the call moves to
 * the background a moment later, and the line is answered within seconds
 * rather than at the minute.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import jobWorkflow from "../../extensions/job-workflow/index.ts";
import { runOrHandOff } from "../../lib/jobs/hand-off.ts";
import { bootPi, type PiSession, waitFor } from "./pi-session.ts";

vi.setConfig({ testTimeout: 30_000 });

/** What the working line says while the line waits on the call. */
const WAITING = "Your message is read once slow ends";

/**
 * How soon the line must be answered: past the hand-off's two seconds,
 * far short of its minute.
 */
const ANSWERED_WITHIN_MS = 8_000;

/** How soon the working line must say what the line waits on. */
const SAID_WITHIN_MS = 1_000;

let pi: PiSession | undefined;
/** Whether the slow call has started. */
let running = false;
/** Ends the slow call's work. */
let finish: () => void = () => {};

/** A tool whose call runs until the test ends it, through the shared wait. */
function slowTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "slow",
		label: "slow",
		description: "Runs until it is told to stop.",
		parameters: Type.Object({}),
		execute: (toolCallId, _params, signal, onUpdate) =>
			runOrHandOff({
				kind: "test",
				label: "a slow call",
				noun: "background call",
				stopping: (jobId) => `Stop it with ${jobId}.`,
				filePrefix: "pi-screen",
				toolCallId,
				session: `screen-${process.pid}`,
				nested: false,
				signal,
				onUpdate,
				bus: api.events,
				run: (owned) => {
					running = true;
					return new Promise((resolve) => {
						const done = () =>
							resolve({
								content: [{ type: "text", text: "slow done" }],
								details: undefined,
							});
						finish = done;
						owned.addEventListener("abort", done, { once: true });
					});
				},
			}),
	});
}

afterEach(async () => {
	finish();
	await pi?.stop();
	pi = undefined;
	running = false;
	vi.restoreAllMocks();
});

describe("a line typed while a long call runs", () => {
	it("says what it waits on, and is answered within seconds", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const session = await bootPi({
			cols: 100,
			rows: 30,
			extensions: [jobWorkflow, slowTool],
		});
		pi = session;
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {})),
			fauxAssistantMessage("MARK-answered the typed line"),
			fauxAssistantMessage("MARK-heard the job end"),
		]);
		await session.prompt("start the slow thing");
		await waitFor(() => running, "the slow call to start");

		const typedAt = Date.now();
		await session.prompt("MARK-typed are you there");
		await waitFor(
			() => session.onScreen(WAITING),
			"the working line to say what the line waits on",
			SAID_WITHIN_MS,
		);
		await waitFor(
			() => session.onScreen("MARK-answered"),
			"the typed line's answer",
			ANSWERED_WITHIN_MS,
		);

		expect(
			Date.now() - typedAt,
			"ms from the typed line to its answer",
		).toBeLessThan(ANSWERED_WITHIN_MS);
		expect(
			await session.onScreen(WAITING),
			"the working line still saying the line waits, once it was read",
		).toBe(false);
	});
});
