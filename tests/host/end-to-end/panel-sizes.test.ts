/**
 * One of the harness's views on hosted screens of different sizes: it is
 * sized for the screen it is on, and for the smaller one when two people
 * view one conversation, as pi sizes everything else it draws.
 *
 * The view is the harness's: the fixture's `/view` calls `view` from
 * this checkout's `lib/ui` over 200 numbered rows. A host has no tty, so
 * before a panel read pi's terminal it sized itself for 40 rows on every
 * screen: a short viewer lost its footer off the bottom, and a tall one
 * saw a strip. A view takes six tenths of the screen's rows, less five
 * rows of its own around its body.
 *
 * A view or a gate already open keeps fitting when the screen changes
 * under it: when its one viewer shrinks, and when a smaller viewer
 * joins. Each re-lays itself for the new size and keeps its footer, the
 * way out, rather than staying drawn for the size it opened at. The gate
 * is the fixture's `/gate`, the harness's own; one drawn wider than the
 * screen shows as rows the viewer's terminal had to wrap.
 */
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

/** How long a panel may take to show on a loaded machine. */
const SHOW_MS = 20_000;
/** How long one case may take, opening its conversation included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ESCAPE = "\x1b";
const COLUMNS = 100;
const SHORT = 15;
const TALL = 50;
/** What the view's footer shows, which is the way out of it. */
const FOOTER = "Esc close";
/** Narrower than the screens above, as wide as the harness wraps its words. */
const NARROW = 72;
/** What a focused gate's footer shows, which is the way out of it. */
const GATE_FOOTER = "Esc cancel";

/** The body rows a view has on a screen `rows` high. */
function bodyRows(rows: number): number {
	return Math.max(3, Math.floor(rows * 0.6) - 5);
}

/** Whether row `n` of the view's body is on the screen, as itself. */
function showsRow(screen: readonly string[], n: number): boolean {
	const row = new RegExp(`\\brow ${n}\\b`);
	return screen.some((line) => row.test(line));
}

/**
 * Whether the view on `on` is laid out for a screen `rows` high: its
 * body from its top, exactly that screen's share of it, and its footer.
 */
function fitsView(on: Viewer, rows: number): boolean {
	const screen = on.screen();
	return (
		screen.some((line) => line.includes(FOOTER)) &&
		showsRow(screen, 1) &&
		showsRow(screen, bodyRows(rows)) &&
		!showsRow(screen, bodyRows(rows) + 1)
	);
}

/** How many rows on `on`'s screen carry on a line too wide for it. */
function wrappedRows(on: Viewer): number {
	const buffer = on.terminal.buffer.active;
	let wrapped = 0;
	for (let row = 0; row < on.terminal.rows; row++)
		if (buffer.getLine(buffer.viewportY + row)?.isWrapped) wrapped++;
	return wrapped;
}

/**
 * Whether the gate named `name` on `on` is laid out for its screen: what
 * it asks, its footer, and no line wider than the screen.
 */
function fitsGate(on: Viewer, name: string): boolean {
	const screen = on.screen();
	return (
		screen.some((line) => line.includes(`Gate ${name} asks`)) &&
		screen.some((line) => line.includes(GATE_FOOTER)) &&
		wrappedRows(on) === 0
	);
}

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"the harness's views on hosted screens of two sizes (needs a pi with the host's patches: pnpm test:host)",
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
			"keeps a view's footer on a short viewer",
			async () => {
				const short = await viewer(await conversation(), SHORT);
				short.type(`/view${ENTER}`);
				await short.shows(FOOTER, SHOW_MS);

				const screen = short.screen();
				expect(showsRow(screen, 1), "the body starts at its top").toBe(true);
				expect(
					showsRow(screen, bodyRows(SHORT)),
					"it fills its share of the short screen",
				).toBe(true);
				short.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"grows a view into a tall viewer",
			async () => {
				const tall = await viewer(await conversation(), TALL);
				tall.type(`/view${ENTER}`);
				await tall.shows(FOOTER, SHOW_MS);

				const screen = tall.screen();
				expect(
					showsRow(screen, bodyRows(TALL)),
					"it fills its share of the tall screen",
				).toBe(true);
				expect(
					showsRow(screen, bodyRows(TALL) + 1),
					"and no more than its share",
				).toBe(false);
				tall.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"sizes a view for the smaller of two viewers",
			async () => {
				const both = await conversation();
				const tall = await viewer(both, TALL);
				const short = await viewer(both, SHORT);
				tall.type(`/view${ENTER}`);
				await short.shows(FOOTER, SHOW_MS);
				await tall.shows(FOOTER, SHOW_MS);

				for (const [name, on] of [
					["short", short],
					["tall", tall],
				] as const) {
					const screen = on.screen();
					expect(
						showsRow(screen, bodyRows(SHORT)),
						`the ${name} viewer sees the short screen's share`,
					).toBe(true);
					expect(
						showsRow(screen, bodyRows(SHORT) + 1),
						`and the ${name} viewer sees no more`,
					).toBe(false);
				}
				tall.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"re-lays an open view when its viewer shrinks",
			async () => {
				const one = await viewer(await conversation(), TALL);
				one.type(`/view${ENTER}`);
				await until(
					"the view to fill the tall screen's share",
					() => fitsView(one, TALL),
					SHOW_MS,
				);

				one.resize(SHORT, COLUMNS);

				await until(
					"the view to re-lay itself for the short screen, footer and all",
					() => fitsView(one, SHORT),
					SHOW_MS,
				);
				one.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"re-lays an open view when a shorter viewer joins",
			async () => {
				const both = await conversation();
				const tall = await viewer(both, TALL);
				tall.type(`/view${ENTER}`);
				await until(
					"the view to fill the tall screen's share",
					() => fitsView(tall, TALL),
					SHOW_MS,
				);

				const short = await viewer(both, SHORT);

				for (const [name, on] of [
					["short", short],
					["tall", tall],
				] as const)
					await until(
						`the ${name} viewer to see the view re-laid for the short screen`,
						() => fitsView(on, SHORT),
						SHOW_MS,
					);
				tall.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"re-lays an open gate when its viewer shrinks",
			async () => {
				const one = await viewer(await conversation(), TALL);
				await raise(one, "shrunk");

				one.resize(SHORT, NARROW);

				await until(
					"the gate to re-lay itself for the narrow screen, footer and all",
					() => fitsGate(one, "shrunk"),
					SHOW_MS,
				);
				one.type(ESCAPE);
			},
			CASE_MS,
		);

		it(
			"re-lays an open gate when a smaller viewer joins",
			async () => {
				const both = await conversation();
				const wide = await viewer(both, TALL);
				await raise(wide, "joined");

				const narrow = await viewer(both, SHORT, NARROW);

				for (const [name, on] of [
					["narrow", narrow],
					["wide", wide],
				] as const)
					await until(
						`the ${name} viewer to see the gate re-laid for the narrow screen`,
						() => fitsGate(on, "joined"),
						SHOW_MS,
					);
				wide.type(ESCAPE);
			},
			CASE_MS,
		);
	},
);

/** Raise the fixture's gate named `name` and wait until it holds the keys. */
async function raise(on: Viewer, name: string): Promise<void> {
	on.type(`/gate ${name}${ENTER}`);
	await until(
		`gate ${name} to show, laid out for its screen`,
		() => fitsGate(on, name),
		SHOW_MS,
	);
}

/** A fresh conversation on the host, by its session id. */
async function conversation(): Promise<string> {
	const { sessionId } = await host.open(work.trusted());
	return sessionId;
}

/** A viewer `rows` high, and `columns` wide, on the conversation `sessionId`. */
async function viewer(
	sessionId: string,
	rows: number,
	columns = COLUMNS,
): Promise<Viewer> {
	const attached = await attach(host.path, sessionId, rows, columns);
	viewers.push(attached);
	return attached;
}
