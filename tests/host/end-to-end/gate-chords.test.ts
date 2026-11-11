/**
 * The harness's gate and panel chords, pressed on hosted screens: a tabbed
 * gate submitted with Ctrl+Enter and with Ctrl+S, a gate redirected with
 * Shift+Escape, focus hopped out of a gate and back with Ctrl+Alt+N, and a
 * view and a docked gate zoomed with Ctrl+Alt+F and Ctrl+Alt+M, each drawn
 * at the chord with no other key.
 *
 * Each chord is the bytes a kitty terminal sends, since a host tells every
 * viewer to speak kitty's protocol, and the gates, views and extensions are
 * this checkout's: the fixture's `/gate`, `/tabs` and `/view`, with the
 * panel-lifecycle and panel-zoom extensions loaded. Zoom is kept for each
 * screen, so zooming one conversation leaves another's view as it was.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** How long a turn or a panel may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening its conversations included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const GATE_ROWS = 30;
const VIEW_ROWS = 50;
const COLUMNS = 100;
/** A gate's approve key, as the fixture's `/gate` offers it. */
const APPROVE = "a";
/** What a focused gate's footer shows, and an unfocused one's never does. */
const FOCUSED = "Esc cancel";
/** What a view's footer shows. */
const VIEW_FOOTER = "Esc close";
/**
 * How often to press a gate's key until it answers: a gate ignores keys
 * for a moment after it takes focus, so a mistyped approval can't land.
 */
const PRESS_EVERY_MS = 100;

/** The chords as kitty's protocol sends them. */
const CTRL_ENTER = "\x1b[13;5u";
const CTRL_S = "\x13";
const SHIFT_ESCAPE = "\x1b[27;2u";
const CTRL_ALT_N = "\x1b[110;7u";
const CTRL_ALT_F = "\x1b[102;7u";
const CTRL_ALT_M = "\x1b[109;7u";

/** A view's share of the screen's rows at each zoom, as `panel-height` sets them. */
const NORMAL = 0.6;
const FULLSCREEN = 0.9;
const MINIMIZED = 0.25;

/** The body rows a view has on a screen `rows` high at a zoom's `share`. */
function bodyRows(rows: number, share: number): number {
	return Math.max(3, Math.floor(rows * share) - 5);
}

/** Whether row `n` of the view's body is on the screen, as itself. */
function showsRow(on: Viewer, n: number): boolean {
	const row = new RegExp(`\\brow ${n}\\b`);
	return on.screen().some((line) => row.test(line));
}

/** How many of a tall gate's numbered rows the screen shows. */
function rowsShown(on: Viewer): number {
	return on.screen().filter((line) => /\brow \d+\b/.test(line)).length;
}

/** Whether the screen shows `text` anywhere. */
function showing(on: Viewer, text: string): boolean {
	return on.screen().some((line) => line.includes(text));
}

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"the harness's gate and panel chords on hosted screens (needs a pi with the host's patches: pnpm test:host)",
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
			"submits a tabbed gate with Ctrl+Enter, as its footer says",
			async () => {
				const on = await conversation(GATE_ROWS);
				await raise(on, "tabs", "enter");
				await on.shows("Ctrl+Enter submit", TURN_MS);

				on.type(CTRL_ENTER);
				await answered("enter");
				expect(gated()).toContain("enter submitted");
			},
			CASE_MS,
		);

		it(
			"submits a tabbed gate with Ctrl+S",
			async () => {
				const on = await conversation(GATE_ROWS);
				await raise(on, "tabs", "save");

				on.type(CTRL_S);
				await answered("save");
				expect(gated()).toContain("save submitted");
			},
			CASE_MS,
		);

		it(
			"redirects a gate with Shift+Escape and keeps the feedback",
			async () => {
				const on = await conversation(GATE_ROWS);
				await raise(on, "gate", "elsewhere");

				on.type(SHIFT_ESCAPE);
				await on.shows("Feedback:", TURN_MS);
				// Typed, then Enter on its own, as a terminal sends them: in
				// one chunk with the words, Enter goes into the feedback.
				on.type("another way");
				await on.shows("another way", TURN_MS);
				await submitFeedback(on, "elsewhere");
				expect(gated()).toContain("elsewhere redirected another way");
			},
			CASE_MS,
		);

		it(
			"hops out of a gate to the editor and back with Ctrl+Alt+N",
			async () => {
				const on = await conversation(GATE_ROWS);
				await raise(on, "gate", "hop");

				on.type(CTRL_ALT_N);
				await until(
					"the gate to give up the keys",
					() => !showing(on, FOCUSED),
					TURN_MS,
				);
				on.type("draft words");
				await on.shows("draft words", TURN_MS);
				expect(showing(on, "Gate hop"), "the gate waits on screen").toBe(true);

				on.type(CTRL_ALT_N);
				await on.shows(FOCUSED, TURN_MS);
				await approve(on, "hop");
				expect(gated()).toContain("hop a");
				await on.shows("draft words", TURN_MS);
			},
			CASE_MS,
		);

		it(
			"zooms one conversation's view and leaves another's as it was",
			async () => {
				const zoomed = await conversation(VIEW_ROWS);
				const other = await conversation(VIEW_ROWS);
				zoomed.type(`/view${ENTER}`);
				await zoomed.shows(VIEW_FOOTER, TURN_MS);

				zoomed.type(CTRL_ALT_F);
				await until(
					"the view to fill the screen",
					() => showsRow(zoomed, bodyRows(VIEW_ROWS, FULLSCREEN)),
					TURN_MS,
				);
				expect(
					showsRow(zoomed, bodyRows(VIEW_ROWS, FULLSCREEN) + 1),
					"and no more than a full screen's share",
				).toBe(false);

				other.type(`/view${ENTER}`);
				await other.shows(VIEW_FOOTER, TURN_MS);
				expect(
					showsRow(other, bodyRows(VIEW_ROWS, NORMAL)),
					"the other view has its normal share",
				).toBe(true);
				expect(
					showsRow(other, bodyRows(VIEW_ROWS, NORMAL) + 1),
					"and not the zoomed one's",
				).toBe(false);

				zoomed.type(CTRL_ALT_M);
				await until(
					"the view to shrink to its minimized share",
					() => !showsRow(zoomed, bodyRows(VIEW_ROWS, MINIMIZED) + 1),
					TURN_MS,
				);
				expect(
					showsRow(zoomed, bodyRows(VIEW_ROWS, MINIMIZED)),
					"it still shows its minimized share",
				).toBe(true);
			},
			CASE_MS,
		);

		it(
			"zooms a docked gate taller than its screen",
			async () => {
				const on = await conversation(VIEW_ROWS);
				await raise(on, "gate", "tall");
				const normal = rowsShown(on);
				expect(normal, "the gate shows some of its rows").toBeGreaterThan(0);

				on.type(CTRL_ALT_F);
				await until(
					"the gate to grow to its full screen share",
					() => rowsShown(on) > normal,
					TURN_MS,
				);
				on.type(CTRL_ALT_M);
				await until(
					"the gate to shrink below its normal share",
					() => rowsShown(on) < normal,
					TURN_MS,
				);
				await approve(on, "tall");
				expect(gated()).toContain("tall a");
			},
			CASE_MS,
		);
	},
);

/** A viewer `rows` high on a fresh conversation. */
async function conversation(rows: number): Promise<Viewer> {
	const { sessionId } = await host.open(work.trusted());
	const attached = await attach(host.path, sessionId, rows, COLUMNS);
	viewers.push(attached);
	return attached;
}

/**
 * Raise the fixture's `/gate` or `/tabs` named `name`, and wait until it
 * holds the keys.
 */
async function raise(
	on: Viewer,
	command: "gate" | "tabs",
	name: string,
): Promise<void> {
	on.type(`/${command} ${name}${ENTER}`);
	await on.shows(command === "gate" ? `Gate ${name}` : `Tabs ${name}`, TURN_MS);
	await on.shows(FOCUSED, TURN_MS);
}

/** Approve the gate named `name`, pressing until its answer is kept. */
async function approve(on: Viewer, name: string): Promise<void> {
	let pressed = 0;
	await until(
		`gate ${name} to be approved`,
		() => {
			if (answer(name) !== undefined) return true;
			if (Date.now() - pressed >= PRESS_EVERY_MS) {
				on.type(APPROVE);
				pressed = Date.now();
			}
			return false;
		},
		TURN_MS,
	);
}

/**
 * Submit the feedback typed into the gate named `name`, pressing Enter
 * until its answer is kept, since a press that lands while the editor
 * arms is dropped. Only while the feedback shows, so no Enter reaches
 * pi's editor once the gate has gone.
 */
async function submitFeedback(on: Viewer, name: string): Promise<void> {
	let pressed = 0;
	await until(
		`gate ${name} to be answered`,
		() => {
			if (answer(name) !== undefined) return true;
			if (showing(on, "Feedback:") && Date.now() - pressed >= PRESS_EVERY_MS) {
				on.type(ENTER);
				pressed = Date.now();
			}
			return false;
		},
		TURN_MS,
	);
}

/** Wait until the gate named `name` has kept an answer. */
async function answered(name: string): Promise<void> {
	await until(
		`gate ${name} to be answered`,
		() => answer(name) !== undefined,
		TURN_MS,
	);
}

/** The answer the gate named `name` kept, if it has. */
function answer(name: string): string | undefined {
	return gated().find((line) => line.startsWith(`${name} `));
}

/** Each gate's answer, in the order they were given: `name said`. */
function gated(): string[] {
	const file = join(sealed.home, "gated");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean);
}
