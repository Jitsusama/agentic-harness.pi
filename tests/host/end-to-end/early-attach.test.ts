/**
 * A viewer attaching to a conversation its host lists but hasn't yet
 * given a screen. On 11 November a session moved into the background
 * host in place, and its window attached 0.8 s after the host took it
 * on: the host listed the conversation as it registered it, seconds
 * before pi built its screen, so it answered the attach and then found
 * no screen to show. The attach client ended, and the window it held
 * closed on Joel's workspace. Here the conversation's own extension
 * holds its start between the two, and the attach is answered only once
 * the screen exists, which it then shows.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quietFor, until } from "../../support/until.ts";
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

/** How long a start, a turn or a frame may take on a loaded machine. */
const TURN_MS = 20_000;
/** How long the case may take, opening its conversation included. */
const CASE_MS = 60_000;
/**
 * How long a host answering an attach at once would take to answer it,
 * on a loaded machine: a local socket's round trip is a few
 * milliseconds, so ten of these with no answer is a held attach.
 */
const ANSWER_MS = 100;
const ROWS = 30;
const COLUMNS = 120;
/** The file the folder's extension waits for before it lets its start go on. */
const GO_ON = "go-on";

let sealed: Seal;
let host: ScreenHost;
let work: Folders;
const viewers: Viewer[] = [];

describe.skipIf(!packageDir)(
	"an attach before its conversation's screen exists (needs a pi with the host's patches: pnpm test:host)",
	() => {
		beforeAll(async () => {
			if (!packageDir) return;
			sealed = await seal();
			work = folders(sealed);
			host = await startScreenHost(sealed, packageDir);
		}, CASE_MS);
		afterAll(async () => {
			for (const on of viewers) await on.leave().catch(() => {});
			await host?.stop();
			await sealed?.dispose();
		}, CASE_MS);

		it(
			"answers once the screen exists and shows it, rather than finding none",
			async () => {
				const cwd = heldAtStart();
				const opening = host.open(cwd, "held start");
				const sessionId = await listed();
				let answered = false;
				const attaching = attach(host.path, sessionId, ROWS, COLUMNS).finally(
					() => {
						answered = true;
					},
				);
				await quietFor(ANSWER_MS, 10);
				expect(answered, "the host answered before the screen existed").toBe(
					false,
				);

				writeFileSync(join(cwd, GO_ON), "");
				await opening;
				const viewer = await attaching;
				viewers.push(viewer);

				await viewer.shows("heard: held start", TURN_MS);
				expect(host.errors()).not.toContain("Conversation has no screen");
			},
			CASE_MS,
		);
	},
);

/**
 * A fresh trusted folder whose own extension holds its conversation's
 * start until GO_ON appears there: pi loads it as it builds the
 * conversation, after the host lists it and before its screen exists.
 */
function heldAtStart(): string {
	const cwd = work.trusted();
	const extensions = join(cwd, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	writeFileSync(
		join(extensions, "held.ts"),
		`import { existsSync } from "node:fs";
export default async function () {
	while (!existsSync(${JSON.stringify(join(cwd, GO_ON))}))
		await new Promise((done) => setTimeout(done, 50));
}
`,
	);
	return cwd;
}

/** The conversation the host lists, once it lists one. */
async function listed(): Promise<string> {
	let sessionId: string | undefined;
	await until(
		"the host to list the conversation it is starting",
		async () => {
			sessionId = (await host.list())[0]?.sessionId;
			return sessionId !== undefined;
		},
		TURN_MS,
	);
	if (sessionId === undefined) throw new Error("the host listed nothing");
	return sessionId;
}
