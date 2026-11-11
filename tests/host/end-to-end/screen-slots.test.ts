/**
 * Two conversations on one host, each raising one of the harness's own
 * gates on its own screen: a gate in one leaves the other's screen free,
 * and one conversation's `/new` leaves the other's waiting gate up.
 *
 * The gates are the harness's: the fixture's `/gate` command calls
 * `showSinglePrompt` from this checkout's `lib/ui`, and its agent folder
 * loads this checkout's panel-lifecycle and panel-zoom extensions, so the
 * queue, the dock, the open panels and the session end are the code a
 * person runs. Before each screen had its own, the second gate queued
 * behind the first, and the `/new` cancelled the other's gate.
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

/** How long a turn of the scripted model may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening its conversations included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ROWS = 30;
const COLUMNS = 100;
/** A gate's approve key, as the fixture's `/gate` offers it. */
const APPROVE = "a";
/** What a focused gate's footer shows, and an unfocused one's never does. */
const FOCUSED = "Esc cancel";
/**
 * How often to press a gate's key until it answers: a gate ignores keys
 * for a moment after it takes focus, so a mistyped approval can't land.
 */
const PRESS_EVERY_MS = 100;

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"the harness's gates on two conversations' screens (needs a pi with the host's patches: pnpm test:host)",
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
			"shows a gate in one conversation while another's waits",
			async () => {
				const first = await conversation();
				const second = await conversation();

				await raise(first, "first");
				await raise(second, "second");
				await approve(second, "second");

				expect(gated(), "only the second gate is answered").toEqual([
					"second a",
				]);
				await first.shows("Gate first");
				await approve(first, "first");
				expect(gated()).toEqual(["second a", "first a"]);
			},
			CASE_MS,
		);

		it(
			"leaves another conversation's gate up through one's /new",
			async () => {
				const first = await conversation();
				const second = await conversation();
				const before = gated().length;

				await raise(first, "kept");
				second.type(`/new${ENTER}`);
				// Words sent while pi starts the new session are lost, on plain pi
				// too, so they wait for it; this case is about the gate, not typing
				// ahead.
				await second.shows("New session started", TURN_MS);
				second.type(`after new${ENTER}`);
				await second.shows("heard: after new", TURN_MS);

				expect(gated().slice(before), "nothing answered the gate").toEqual([]);
				await first.shows("Gate kept");
				await approve(first, "kept");
				expect(gated().slice(before)).toEqual(["kept a"]);
			},
			CASE_MS,
		);
	},
);

/** A viewer on a fresh conversation. */
async function conversation(): Promise<Viewer> {
	const { sessionId } = await host.open(work.trusted());
	const attached = await attach(host.path, sessionId, ROWS, COLUMNS);
	viewers.push(attached);
	return attached;
}

/** Raise the fixture's gate named `name` and wait until it holds the keys. */
async function raise(on: Viewer, name: string): Promise<void> {
	on.type(`/gate ${name}${ENTER}`);
	await on.shows(`Gate ${name}`, TURN_MS);
	await on.shows(FOCUSED, TURN_MS);
}

/** Approve the gate named `name`, pressing until its answer is kept. */
async function approve(on: Viewer, name: string): Promise<void> {
	let pressed = 0;
	await until(
		`gate ${name} is approved`,
		() => {
			if (gated().some((line) => line.startsWith(`${name} `))) return true;
			if (Date.now() - pressed >= PRESS_EVERY_MS) {
				on.type(APPROVE);
				pressed = Date.now();
			}
			return false;
		},
		TURN_MS,
	);
}

/** Each gate's answer, in the order they were given: `name key`. */
function gated(): string[] {
	const file = join(sealed.home, "gated");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean);
}
