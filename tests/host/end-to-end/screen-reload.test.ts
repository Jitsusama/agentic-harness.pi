/**
 * A hosted conversation reloaded between its runs, as the harness's
 * follower reloads one once its install moves: its screen draws the new
 * load's footer, takes a resize and the next words, and the host stays
 * up. The fixture's `/footer` reads the conversation's folder from its
 * load as it draws, and each later load asks for a frame before it sets
 * its own, so
 * a screen still drawing the old load's footer once pi invalidated that
 * load throws there, as the background host did on 11 November.
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

/** How long a turn, a reload or a frame may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening its conversation included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ROWS = 30;
const COLUMNS = 100;
/** The fixture footer's line, naming the load that drew it. */
const FOOTER = /footer of load (\d+) in /;

/** The load the screen's footer names, if it shows one. */
function footerLoad(on: Viewer): number | undefined {
	for (const line of on.screen()) {
		const drawn = FOOTER.exec(line);
		if (drawn) return Number(drawn[1]);
	}
	return undefined;
}

let sealed: Seal;
let host: ScreenHost;
let work: Folders;
const viewers: Viewer[] = [];

describe.skipIf(!packageDir)(
	"a hosted screen reloaded between runs (needs a pi with the host's patches: pnpm test:host)",
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
			"draws the new load's footer, takes a resize and the next words, and keeps the host up",
			async () => {
				const { sessionId } = await host.open(work.trusted());
				const on = await attach(host.path, sessionId, ROWS, COLUMNS);
				viewers.push(on);
				on.type(`/footer${ENTER}`);
				await on.shows(FOOTER, TURN_MS);
				const first = footerLoad(on);

				on.type(`/host-reload${ENTER}`);
				await until(
					"the new load's footer to be drawn",
					() => {
						const now = footerLoad(on);
						return now !== undefined && now !== first;
					},
					TURN_MS,
				).catch((error: unknown) => {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}; the host said: ${host.errors()}`,
					);
				});

				on.resize(ROWS + 10, COLUMNS + 20);
				on.type(`after the reload${ENTER}`);
				await on.shows("heard: after the reload", TURN_MS);
				expect(
					footerLoad(on),
					"the resized screen still draws the new load's footer",
				).not.toBe(first);
				expect(
					(await host.list()).map((held) => held.sessionId),
					"the host still holds the conversation",
				).toContain(sessionId);
				expect(host.errors(), "the host reported no stale load").not.toMatch(
					/stale/,
				);
			},
			CASE_MS,
		);
	},
);
