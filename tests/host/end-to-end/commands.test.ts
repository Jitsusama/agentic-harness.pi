/**
 * The commands a person types into pi's editor on a hosted conversation's
 * screen, beyond the words it sends the model: a `!` line runs in the
 * conversation's shell, `/compact` folds its history into a summary, and
 * `/resume` takes up an earlier conversation from its folder. The same
 * sealed host as keys.test.ts, with viewers attached through its socket.
 * Runs on the host's pi as support/host-pi.ts finds it; an ordinary run
 * without one skips it, and `pnpm test:host` fails instead.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
const ROWS = 30;
const COLUMNS = 100;
/** Recent history `/compact` keeps, small enough that one earlier turn is folded. */
const KEEP_RECENT_TOKENS = 1;
/** The resume selector's row for the earlier conversation, marked as the one Enter takes. */
const SELECTED_EARLIER = /^\s*› resumable words\b/;

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"the commands typed on a hosted conversation's screen (needs a pi with the host's patches: pnpm test:host)",
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
			"runs a ! line in the conversation's folder and shows what it printed",
			async () => {
				const cwd = work.trusted();
				writeFileSync(join(cwd, "only-here.txt"), "");
				const { sessionId } = await host.open(cwd);
				const typing = await viewer(sessionId);

				// The shell works out the number, so the answer is never what was typed.
				typing.type(`!ls; echo bang-$((6*7))${ENTER}`);

				await typing.shows("bang-42", TURN_MS);
				await typing.shows("only-here.txt");
			},
			CASE_MS,
		);

		it(
			"folds the earlier turns into a summary on /compact, and answers after",
			async () => {
				const cwd = work.trusted();
				mkdirSync(join(cwd, ".pi"));
				writeFileSync(
					join(cwd, ".pi", "settings.json"),
					JSON.stringify({
						compaction: { keepRecentTokens: KEEP_RECENT_TOKENS },
					}),
				);
				const { sessionId } = await host.open(cwd);
				const typing = await viewer(sessionId);
				typing.type(`alpha${ENTER}`);
				await typing.shows("heard: alpha", TURN_MS);
				typing.type(`beta${ENTER}`);
				await typing.shows("heard: beta", TURN_MS);

				typing.type(`/compact${ENTER}`);

				await typing.shows("Compacted from", TURN_MS);
				typing.type(`gamma${ENTER}`);
				await typing.shows("heard: gamma", TURN_MS);
			},
			CASE_MS,
		);

		it(
			"takes up an earlier conversation from its folder on /resume, under that conversation's id",
			async () => {
				const cwd = work.trusted();
				const { sessionId: earlier } = await host.open(cwd);
				const typing = await viewer(earlier);
				typing.type(`resumable words${ENTER}`);
				await typing.shows("heard: resumable words", TURN_MS);
				typing.type(`/new${ENTER}`);
				// Words sent while pi starts the new session are lost, on plain pi
				// too, so they wait for it.
				await typing.shows("New session started", TURN_MS);
				typing.type(`later words${ENTER}`);
				await typing.shows("heard: later words", TURN_MS);

				typing.type(`/resume${ENTER}`);
				await typing.shows("Resume Session", TURN_MS);
				typing.type("resumable");
				await until(
					"the search to select the earlier conversation",
					() => typing.screen().some((row) => SELECTED_EARLIER.test(row)),
					TURN_MS,
				).catch((failed: unknown) => {
					throw new Error(
						`${String(failed)}; the screen shows:\n${typing.screen().join("\n")}`,
					);
				});
				typing.type(ENTER);

				await typing.shows("Resumed session", TURN_MS);
				await until(
					"the host to hold the earlier conversation again",
					async () =>
						(await host.list()).some((held) => held.sessionId === earlier),
					TURN_MS,
				);
				typing.type(`once more${ENTER}`);
				await typing.shows("heard: once more", TURN_MS);
				expect(
					shown(typing, "heard: resumable words"),
					"the earlier conversation's words are on screen",
				).toBe(true);
			},
			CASE_MS,
		);
	},
);

/** Whether a viewer's screen shows `words` anywhere. */
function shown(on: Viewer, words: string): boolean {
	return on.screen().join("\n").includes(words);
}

async function viewer(sessionId: string): Promise<Viewer> {
	const attached = await attach(host.path, sessionId, ROWS, COLUMNS);
	viewers.push(attached);
	return attached;
}
