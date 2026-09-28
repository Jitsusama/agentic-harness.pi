/**
 * The harness itself: it boots pi, drives a turn, sees what pi paints and
 * catches a desync when there is one. Without the last case a verdict of
 * "clean" would mean nothing, so a row written behind pi's back has to be
 * reported.
 */

import { afterEach, describe, expect, it } from "vitest";
import { bootPi, type PiSession, waitFor } from "./pi-session.ts";

let pi: PiSession | undefined;

afterEach(async () => {
	await pi?.stop();
	pi = undefined;
});

describe("the screen harness", () => {
	it("runs a turn and paints the answer", async () => {
		pi = await bootPi();
		pi.answer("MARK-answer from the faux model");
		await pi.prompt("hello");
		await waitFor(() => pi?.onScreen("MARK-answer") ?? false, "the answer");
		const verdict = await pi.verdict();
		expect(verdict.desync).toEqual([]);
		expect(verdict.hygiene).toEqual([]);
	});

	it("shows an extension's widget above the editor", async () => {
		pi = await bootPi({
			extensions: [
				(api) => {
					api.on("session_start", (_event, ctx) => {
						ctx.ui.setWidget("probe", ["MARK-widget"]);
					});
				},
			],
		});
		await waitFor(() => pi?.onScreen("MARK-widget") ?? false, "the widget");
		expect(pi.editorFocused()).toBe(true);
	});

	it("reports a row written behind pi's back as a desync", async () => {
		pi = await bootPi();
		pi.answer("MARK-answer");
		await pi.prompt("hello");
		await waitFor(() => pi?.onScreen("MARK-answer") ?? false, "the answer");
		pi.term.write("\x1b[1;1HMARK-stray");
		pi.ctx().ui.setStatus("nudge", "repaint");
		await waitFor(
			async () => ((await pi?.verdict())?.frames ?? 0) > 0,
			"a frame",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const verdict = await pi.verdict();
		expect(verdict.desync.length).toBeGreaterThan(0);
	});
});
