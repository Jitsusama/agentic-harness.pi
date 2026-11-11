/**
 * Two conversations on one real host, one of them with a footer that
 * throws on every frame, as a stale extension's did when it took down
 * every conversation in a host at once: the throw ends at its own
 * conversation, whose extensions' screen comes down and, should it throw
 * again, whose conversation closes, while the other answers throughout.
 *
 * The fixture's `/throw` command sets that footer; the host is the
 * screens and engine the host program composes, with nothing listening
 * for a throw that escapes them, so one that did would end the process.
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

/** How long a turn of the scripted model may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long one case may take, opening its conversations included. */
const CASE_MS = 60_000;
const ENTER = "\r";
const ROWS = 30;
const COLUMNS = 100;
/** What the host's screen says once it has taken the extensions' screen down. */
const TAKEN_DOWN = "Something on this screen failed";
/** What the host tells its journal of each contained throw. */
const CONTAINED = "threw where nothing caught it";

let sealed: Seal;
let host: ScreenHost;
const viewers: Viewer[] = [];
let work: Folders;

describe.skipIf(!packageDir)(
	"a throw from one conversation's screen (needs a pi with the host's patches: pnpm test:host)",
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
			"takes down that screen's extensions, and both conversations answer on",
			async () => {
				const [faulty, faultyId] = await conversation();
				const [other] = await conversation();

				faulty.type(`/throw${ENTER}`);
				await faulty.shows(TAKEN_DOWN, TURN_MS);
				await say(other, "still here");
				await say(faulty, "after the throw");

				expect(host.errors()).toContain(
					`Conversation ${faultyId} ${CONTAINED}`,
				);
				expect((await host.list()).map((held) => held.sessionId)).toContain(
					faultyId,
				);
			},
			CASE_MS,
		);

		it(
			"closes only that conversation when its screen throws again",
			async () => {
				const [faulty, faultyId] = await conversation();
				const [other, otherId] = await conversation();

				faulty.type(`/throw${ENTER}`);
				await faulty.shows(TAKEN_DOWN, TURN_MS);
				faulty.type(`/throw${ENTER}`);
				await host.gone(faultyId, TURN_MS);
				await say(other, "after the close");

				const held = (await host.list()).map((each) => each.sessionId);
				expect(held).toContain(otherId);
				expect(held).not.toContain(faultyId);
			},
			CASE_MS,
		);
	},
);

/** A viewer on a fresh conversation, and the conversation's id. */
async function conversation(): Promise<[Viewer, string]> {
	const { sessionId } = await host.open(work.trusted());
	const attached = await attach(host.path, sessionId, ROWS, COLUMNS);
	viewers.push(attached);
	return [attached, sessionId];
}

/** Say `words` and wait for the scripted model's echo of them. */
async function say(on: Viewer, words: string): Promise<void> {
	on.type(`${words}${ENTER}`);
	await on.shows(`heard: ${words}`, TURN_MS);
}
