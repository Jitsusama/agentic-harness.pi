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
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** The body rows a view has on a screen `rows` high. */
function bodyRows(rows: number): number {
	return Math.max(3, Math.floor(rows * 0.6) - 5);
}

/** Whether row `n` of the view's body is on the screen, as itself. */
function showsRow(screen: readonly string[], n: number): boolean {
	const row = new RegExp(`\\brow ${n}\\b`);
	return screen.some((line) => row.test(line));
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
				const [short] = await conversation(SHORT);
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
				const [tall] = await conversation(TALL);
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
				const [tall, short] = await conversation(TALL, SHORT);
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
	},
);

/** Viewers of these heights on one fresh conversation, in that order. */
async function conversation(...heights: number[]): Promise<Viewer[]> {
	const { sessionId } = await host.open(work.trusted());
	const attached: Viewer[] = [];
	for (const rows of heights)
		attached.push(await attach(host.path, sessionId, rows, COLUMNS));
	viewers.push(...attached);
	return attached;
}
