/**
 * A gate raised while another tool's output streams in beside it, in real
 * pi.
 *
 * The complaint this answers, Joel's of 11 November: "text from ask
 * dialogs disappearing as text comes in". Pi runs one message's tool calls
 * at once, so a gate's question can be up while a sibling tool's rows grow
 * below it. The dock keeps every row that can still change on screen, and
 * a gate that gave up a row to each new line of output shrank to the one
 * row that says it is waiting, its question gone.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

vi.setConfig({ testTimeout: 30_000 });

const COLS = 100;
/** Terminal heights: a roomy one, and one where gate and output can't both fit whole. */
const HEIGHTS = [30, 20];

/** Lines the streaming tool writes, more than the terminal holds. */
const STREAMED = 40;

/** How long between the streaming tool's lines. */
const LINE_MS = 20;

let pi: PiSession | undefined;
let release: (() => void) | undefined;
/** How many lines the streaming tool has written so far. */
let written = 0;

/** A tool that raises a gate of four body rows and waits for its answer. */
function gateTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "ask_gate",
		label: "Ask Gate",
		description: "Raises a gate.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const result = await showSinglePrompt(ctx, {
				title: "MARK-title Approve the thing?",
				content: (_theme: unknown, width: number) =>
					Array.from({ length: 4 }, (_, i) =>
						`MARK-body-${i} ${"lorem ipsum ".repeat(6)}`.slice(0, width),
					),
				actions: [{ key: "r", label: "Reject" }],
			});
			return {
				content: [
					{ type: "text", text: `MARK-result ${JSON.stringify(result)}` },
				],
				details: {},
			};
		},
	});
}

/** A tool whose output streams in a line at a time, then waits. */
function streamTool(api: ExtensionAPI): void {
	api.registerTool({
		name: "stream",
		label: "Stream",
		description: "Writes lines as it goes.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, onUpdate) {
			const lines: string[] = [];
			for (let i = 0; i < STREAMED; i++) {
				lines.push(`MARK-out-${i}`);
				written = i + 1;
				onUpdate?.({
					content: [{ type: "text", text: lines.join("\n") }],
					details: {},
				});
				// Paced, so each line lands in a frame of its own as output does.
				await sleep(LINE_MS);
			}
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {},
			};
		},
	});
}

beforeEach(() => {
	written = 0;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	release?.();
	release = undefined;
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

describe("a gate beside a tool whose output streams in", () => {
	it.each(
		HEIGHTS,
	)("keeps its question on screen while the output grows, %i rows", async (rows) => {
		const session = await bootPi({
			cols: COLS,
			rows,
			extensions: [gateTool, streamTool, panelLifecycle],
		});
		pi = session;
		session.faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("ask_gate", {}),
				fauxToolCall("stream", {}),
			]),
			fauxAssistantMessage("MARK-after"),
		]);
		session.mark("stream");
		await session.prompt("ask while it streams");
		await waitFor(() => session.onScreen("MARK-body-3"), "the gate's body");

		const lost: number[] = [];
		while (release === undefined) {
			if (!(await session.onScreen("MARK-body-0"))) lost.push(written);
			// Twice a line, so every line's frame is looked at while it's up.
			await sleep(LINE_MS / 2);
		}
		// A few frames past the last line, when the dock has dealt its room.
		await sleep(100);
		if (!(await session.onScreen("MARK-body-0"))) lost.push(written);

		expect(
			lost,
			"the lines of output written when the gate's question was off screen",
		).toEqual([]);
		// Pi previews a running tool's first lines and counts the rest.
		expect(
			await session.onScreen("more lines"),
			"the output's preview is on screen whole, down to its count",
		).toBe(true);
		const verdict = await session.verdict();
		expect(verdict.desync, "frames that drew other than pi meant").toEqual([]);
		expect(verdict.redrawsAt, "whole-screen redraws while it streamed").toEqual(
			[],
		);
	});
});
