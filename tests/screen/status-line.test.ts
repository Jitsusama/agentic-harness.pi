/**
 * The status line on real pi: drawn as the session starts, and drawn again
 * the moment a reload ends, not only once something else happens.
 */

import { afterEach, describe, expect, it } from "vitest";
import statusLine from "../../extensions/status-line-widget/index.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

let session: PiSession | undefined;

afterEach(async () => {
	await session?.stop();
	session = undefined;
});

/**
 * The context gauge, in either of its forms.
 *
 * A share (`◔ 4%`) when the line has had to give way, a count (`◔ 3k`)
 * when it fits, and which one depends on how long this checkout's path
 * and branch are. A test that wanted the share passed only where the
 * path happened to be long enough, and failed in CI from the day it
 * landed.
 */
const GAUGE = /[\u25d4\u25d1\u25d5\u25cf] \d+(k|%)/;

/** The last row on screen that holds anything: pi's footer. */
async function bottom(of: PiSession): Promise<string> {
	const rows = await of.viewport();
	return rows.filter((row: string) => row.trim() !== "").at(-1) ?? "";
}

describe("the status line", () => {
	it("is drawn as the session starts", async () => {
		session = await bootPi({
			extensions: [{ name: "status-line", factory: statusLine }],
		});
		await waitFor(
			async () => (await bottom(session as PiSession)).includes("faux-1"),
			"the status line to name the model",
			3000,
		);
	});

	it("is drawn again as soon as a reload ends", async () => {
		session = await bootPi({
			extensions: [{ name: "status-line", factory: statusLine }],
		});
		const live = session;
		await waitFor(
			async () => (await bottom(live)).includes("faux-1"),
			"the status line to name the model",
			3000,
		);
		await live.type("/reload");
		await live.key("enter");
		await waitFor(
			async () => !(await live.onScreen("Reloading keybindings")),
			"the reload to end",
			3000,
		);
		// Nothing else happens: no prompt, no tool, no keystroke.
		await sleep(300);
		expect(await bottom(live)).toContain("faux-1");
	});

	it("is drawn again after a reload on a screen the transcript fills", async () => {
		session = await bootPi({
			cols: 76,
			rows: 40,
			extensions: [
				{ name: "status-line", factory: statusLine },
				{
					name: "quest-line",
					factory: (pi) => {
						pi.on("session_start", (_event, ctx) => {
							ctx.ui.setWidget("quest", [
								"MARK-quest a quest line above the editor",
							]);
						});
					},
				},
			],
		});
		const live = session;
		const long = Array.from({ length: 60 }, (_, at) => `line ${at}`).join(
			"\n\n",
		);
		live.answer(long);
		await live.prompt("fill the screen");
		await waitFor(() => live.onScreen("line 59"), "the answer", 3000);
		await waitFor(
			async () => GAUGE.test(await bottom(live)),
			"the status line to show its gauge",
			3000,
		);
		await live.type("/reload");
		await live.key("enter");
		await waitFor(
			async () => !(await live.onScreen("Reloading keybindings")),
			"the reload to end",
			3000,
		);
		await sleep(300);
		const rows = await live.viewport();
		expect(rows.filter((row) => row.includes("MARK-quest"))).toHaveLength(1);
		expect(await bottom(live)).toMatch(GAUGE);
		const verdict = await live.verdict();
		expect(verdict.desync).toEqual([]);
	});
});
