/**
 * The keys and the mouse a person uses at pi's own screen, on a hosted
 * conversation's: the same sealed host as screens.test.ts, viewers
 * attached through its socket, each sending what kitty sends for the key
 * under the keyboard protocol pi asks for, and reading back what pi's
 * fullscreen view draws. Runs on the host's pi as support/host-pi.ts
 * finds it; an ordinary run without one skips it, and `pnpm test:host`
 * fails instead.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { until } from "../../support/until.ts";
import { type Folders, folders } from "./support/folders.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "./support/host-pi.ts";
import { type ScreenHost, startScreenHost } from "./support/screen-host.ts";
import { type Seal, seal } from "./support/seal.ts";
import { attach, type Viewer } from "./support/viewer.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

/** How long a turn of the scripted model may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening and attaching included. */
const CASE_MS = 60_000;
const ENTER = "\r";

/** Each key as kitty sends it under the flags pi asks for. */
const KEY = {
	escape: "\u001b[27u",
	ctrlC: "\u001b[99;5u",
	ctrlL: "\u001b[108;5u",
	ctrlO: "\u001b[111;5u",
	ctrlT: "\u001b[116;5u",
	ctrlShiftF: "\u001b[102;6u",
	altEnter: "\u001b[13;3u",
	pageUp: "\u001b[5~",
	ctrlHome: "\u001b[1;5H",
	ctrlEnd: "\u001b[1;5F",
	ctrlShiftUp: "\u001b[1;6A",
	ctrlShiftDown: "\u001b[1;6B",
	altUp: "\u001b[1;3A",
	ctrlJ: "\u001b[106;5u",
	ctrlW: "\u001b[119;5u",
	ctrlY: "\u001b[121;5u",
	ctrlMinus: "\u001b[45;5u",
} as const;
/** A wheel notch upward over the screen, in the SGR mouse reports pi asks for. */
const WHEEL_UP = "\u001b[<64;10;10M";
/** Fewer notches than would reach the top of a long answer from a page above its end. */
const NOTCHES = 2;
/** The rows of a viewer, fewer than a long answer's 120 lines. */
const ROWS = 30;
const COLUMNS = 100;
/** A row of the scripted model's long answer, which a scrolled view ends with its scrollbar. */
const ANSWER_LINE = /^\s*line (\d+)\b/;
/** The longest line of the long answer. */
const LAST_LINE = 120;
/** A copy sent to the viewer's clipboard, OSC 52, and the text it holds in base64. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC opens with ESC.
const COPY = /\u001b\]52;c;([A-Za-z0-9+/=]+)/g;
/** Lines in the file the model reads, more than a collapsed read shows. */
const NOTES = 60;

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"the keys on a hosted conversation's screen (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const viewer of viewers) await viewer.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"scrolls a long answer back with the wheel and PgUp, and jumps to its top and its end",
			async () => {
				const reading = await longAnswer();

				reading.type(KEY.pageUp);
				await until(
					"PgUp scrolls the answer back",
					() => lastShown(reading) < LAST_LINE,
					TURN_MS,
				);
				const paged = lastShown(reading);

				for (let notch = 0; notch < NOTCHES; notch++) reading.type(WHEEL_UP);
				await until(
					"the wheel scrolls it back further",
					() => lastShown(reading) < paged,
					TURN_MS,
				);

				reading.type(KEY.ctrlHome);
				await reading.shows(/^\s*line 1\b/m);

				reading.type(KEY.ctrlEnd);
				await until(
					"Ctrl+End comes back to the end",
					() => lastShown(reading) === LAST_LINE,
					TURN_MS,
				);
			},
			CASE_MS,
		);

		it(
			"jumps back a message at a time on Ctrl+Shift+Up and forward on Ctrl+Shift+Down",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const reading = await viewer(sessionId);
				reading.type(`long answer alpha${ENTER}`);
				await reading.shows(`line ${LAST_LINE} alpha`, TURN_MS);
				reading.type(`long answer beta${ENTER}`);
				await reading.shows(`line ${LAST_LINE} beta`, TURN_MS);
				// pi marks where each message starts, prompt and answer alike,
				// and a jump scrolls the next mark to the top of the screen.
				const jumps: [string, string][] = [
					[KEY.ctrlShiftUp, "line 1 beta"],
					[KEY.ctrlShiftUp, "long answer beta"],
					[KEY.ctrlShiftUp, "line 1 alpha"],
					[KEY.ctrlShiftDown, "long answer beta"],
				];
				for (const [key, lands] of jumps) {
					reading.type(key);
					await until(
						`a jump to put ${lands} at the top`,
						() => top(reading) === lands,
						TURN_MS,
					).catch((failed: unknown) => {
						throw new Error(`${String(failed)}; the top shows ${top(reading)}`);
					});
				}
			},
			CASE_MS,
		);

		it(
			"searches the transcript on Ctrl+Shift+F",
			async () => {
				const reading = await longAnswer();

				reading.type(KEY.ctrlShiftF);
				reading.type("line 7");

				// line 7 and lines 70 to 79.
				await reading.shows(/\b\d+\/11\b/);
			},
			CASE_MS,
		);

		it(
			"stops a running answer on Escape",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const stopping = await viewer(sessionId);
				stopping.type(`hold until never${ENTER}`);
				await stopping.shows("Working");

				stopping.type(KEY.escape);

				// pi says the abort's own words when the stop lands while the
				// answer is still being asked for, and its own otherwise.
				await stopping.shows(
					/Operation aborted|This operation was aborted/,
					TURN_MS,
				);
				await host.idle(sessionId, TURN_MS);
			},
			CASE_MS,
		);

		it(
			"opens the session tree on Escape twice",
			async () => {
				const { sessionId } = await host.open(work.trusted(), "a first turn");
				const looking = await viewer(sessionId);
				await looking.shows("heard: a first turn");

				looking.type(KEY.escape);
				looking.type(KEY.escape);

				await looking.shows("Session Tree");
			},
			CASE_MS,
		);

		it(
			"clears what was typed on Ctrl+C",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const typing = await viewer(sessionId);
				typing.type("half a thought");
				await typing.shows("half a thought");

				typing.type(KEY.ctrlC);

				await until(
					"Ctrl+C clears the editor",
					() => !typing.screen().join("\n").includes("half a thought"),
					TURN_MS,
				);
			},
			CASE_MS,
		);

		it(
			"queues a follow-up on Alt+Enter during a run, and answers it after",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const queuing = await viewer(sessionId);
				queuing.type(`hold until queued${ENTER}`);
				await queuing.shows("Working");

				queuing.type(`and then this${KEY.altEnter}`);
				await queuing.shows("Follow-up: and then this");
				writeFileSync(join(sealed.home, "queued"), "");

				await queuing.shows("released: queued", TURN_MS);
				await queuing.shows("heard: and then this", TURN_MS);
			},
			CASE_MS,
		);

		it(
			"takes a queued follow-up back into the editor on Alt+Up, unsent",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const queuing = await viewer(sessionId);
				queuing.type(`hold until dequeued${ENTER}`);
				await queuing.shows("Working");
				queuing.type(`not after all${KEY.altEnter}`);
				await queuing.shows("Follow-up: not after all");

				queuing.type(KEY.altUp);

				await until(
					"Alt+Up to take the follow-up out of the queue",
					() => !shown(queuing, "Follow-up: not after all"),
					TURN_MS,
				);
				await queuing.shows("not after all");
				writeFileSync(join(sealed.home, "dequeued"), "");
				await queuing.shows("released: dequeued", TURN_MS);
				await host.idle(sessionId, TURN_MS);
				expect(
					shown(queuing, "heard: not after all"),
					"the follow-up taken back is never sent",
				).toBe(false);
			},
			CASE_MS,
		);

		it(
			"breaks a line on Ctrl+J, kills a word on Ctrl+W, yanks it back on Ctrl+Y and undoes on Ctrl+-",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const typing = await viewer(sessionId);
				typing.type(`first row${KEY.ctrlJ}second gone`);
				await typing.shows("second gone");

				typing.type(KEY.ctrlW);
				await until(
					"Ctrl+W to kill the word before the cursor",
					() => !shown(typing, "gone"),
					TURN_MS,
				);
				typing.type(KEY.ctrlY);
				await typing.shows("second gone");
				typing.type(KEY.ctrlMinus);
				await until(
					"Ctrl+- to undo the yank",
					() => !shown(typing, "gone"),
					TURN_MS,
				);
				typing.type(`back${ENTER}`);

				await typing.shows("heard: first row", TURN_MS);
				await typing.shows(/^\W*second back\W*$/m, TURN_MS);
			},
			CASE_MS,
		);

		it(
			"expands a tool's output on Ctrl+O",
			async () => {
				const cwd = work.trusted();
				writeFileSync(
					join(cwd, "notes.txt"),
					Array.from({ length: NOTES }, (_, n) => `note ${n + 1}`).join("\n"),
				);
				const { sessionId } = await host.open(cwd);
				const reading = await viewer(sessionId);
				reading.type(`read notes${ENTER}`);
				await reading.shows(/^\s*done\s*$/m, TURN_MS);
				expect(
					reading.screen().join("\n"),
					"a collapsed read shows the file it read, not what it holds",
				).not.toMatch(/\bnote \d+\b/);

				reading.type(KEY.ctrlO);

				await reading.shows(new RegExp(`note ${NOTES}\\b`));
			},
			CASE_MS,
		);

		it(
			"hides and shows thinking on Ctrl+T",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const thinking = await viewer(sessionId);
				thinking.type(`think first${ENTER}`);
				await thinking.shows("thought it through", TURN_MS);
				await thinking.shows("weighing it up first");

				thinking.type(KEY.ctrlT);
				await until(
					"Ctrl+T hides the thinking",
					() => !thinking.screen().join("\n").includes("weighing it up first"),
					TURN_MS,
				);

				thinking.type(KEY.ctrlT);
				await thinking.shows("weighing it up first");
			},
			CASE_MS,
		);

		it(
			"picks another model in the selector Ctrl+L opens",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const picking = await viewer(sessionId);
				await picking.shows("faux-1");

				picking.type(KEY.ctrlL);
				await picking.shows("faux-2");
				picking.type("faux-2");
				picking.type(ENTER);

				await picking.shows("Model: faux-2");
				picking.type(`on the other${ENTER}`);
				await picking.shows("heard: on the other", TURN_MS);
				expect(
					picking.screen().join("\n"),
					"the footer names the model picked",
				).not.toContain("faux-1");
			},
			CASE_MS,
		);

		it(
			"copies what a drag selects to the viewer's clipboard",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const selecting = await viewer(sessionId);
				selecting.type(`drag over me${ENTER}`);
				await selecting.shows("heard: drag over me", TURN_MS);

				const words = "heard: drag over me";
				const row = selecting
					.screen()
					.findIndex((line) => line.includes(words));
				const column = (selecting.screen()[row] ?? "").indexOf(words);
				const [x, y] = [column + 1, row + 1];
				const end = x + words.length - 1;
				selecting.type(`\u001b[<0;${x};${y}M`);
				selecting.type(`\u001b[<32;${end};${y}M`);
				selecting.type(`\u001b[<0;${end};${y}m`);

				await selecting.sent(new RegExp(COPY.source));
				expect(
					copied(selecting),
					"the copy is what was dragged over",
				).toContain(words);
			},
			CASE_MS,
		);
	},
);

/** A viewer on a fresh conversation that has given its 120-line answer. */
async function longAnswer(): Promise<Viewer> {
	const { sessionId } = await host.open(work.trusted());
	const reading = await viewer(sessionId);
	reading.type(`long answer${ENTER}`);
	await until(
		"the long answer ends",
		() => lastShown(reading) === LAST_LINE,
		TURN_MS,
	);
	return reading;
}

/** The last line of the long answer a viewer's screen shows, or 0 for none. */
function lastShown(on: Viewer): number {
	return Math.max(
		0,
		...on.screen().map((row) => Number(ANSWER_LINE.exec(row)?.[1] ?? 0)),
	);
}

/** Whether a viewer's screen shows `words` anywhere. */
function shown(on: Viewer, words: string): boolean {
	return on.screen().join("\n").includes(words);
}

/** The first words on a viewer's screen, below any blank rows. */
function top(on: Viewer): string {
	return (
		on
			.screen()
			.map((row) => row.trim())
			.find((row) => row !== "") ?? ""
	);
}

/** What the latest copy a viewer was sent holds. */
function copied(on: Viewer): string {
	const copies = [...on.output.join("").matchAll(COPY)];
	return Buffer.from(copies.at(-1)?.[1] ?? "", "base64").toString();
}

async function viewer(sessionId: string): Promise<Viewer> {
	const attached = await attach(host.path, sessionId, ROWS, COLUMNS);
	viewers.push(attached);
	return attached;
}
