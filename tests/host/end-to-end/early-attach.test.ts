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
 *
 * On 18 November six of Joel's windows attached while the background
 * host was starting, and sat blank for 2 h 20 min with nothing in the
 * host's journal to say why. The last case attaches a window while the
 * next host's start is held, and the window must be drawn, the journal
 * saying what its attach waited on and when it was answered.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
/** The file the folder's extension writes once it is holding its start. */
const HOLDING = "holding";
/** How long a viewer waits between tries to reach a host not yet listening. */
const REACH_EVERY_MS = 100;

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
			for (const on of viewers) await on.leave();
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

		// Last, since it replaces the host every case before it shares.
		it(
			"draws a window that attached during the host's start, journaling what it waited on and when it was answered",
			async () => {
				if (!packageDir) throw new Error(hostPiMissing());
				const cwd = heldAtStart();
				writeFileSync(join(cwd, GO_ON), "");
				const { sessionId } = await host.open(cwd, "before the start");
				await host.idle(sessionId, TURN_MS);
				const { path } = host;
				expect(await host.restart(), "the host stops cleanly").toBe(0);
				rmSync(join(cwd, GO_ON));
				rmSync(join(cwd, HOLDING), { force: true });

				const starting = startScreenHost(sealed, packageDir);
				let answered = false;
				const attaching = attachOnceListening(path, sessionId).finally(() => {
					answered = true;
				});
				try {
					// The conversation is being built, whether the start resumes it
					// or the attach wakes it from a park, and the attach waits on it.
					await until(
						"the conversation's start to be held",
						() => existsSync(join(cwd, HOLDING)),
						CASE_MS / 2,
					);
					// Past the fixture host's half a second, so it journals the wait;
					// that line shows the attach reached the host and was held there.
					await quietFor(ANSWER_MS, 10);
					expect(answered, "the host answered while the start was held").toBe(
						false,
					);
				} finally {
					// Let the start go however the held part ended, so a failure
					// leaves a host the suite's end can stop, not one held for good.
					writeFileSync(join(cwd, GO_ON), "");
					host = await starting;
				}
				const viewer = await attaching;
				viewers.push(viewer);
				await viewer.shows("heard: before the start", TURN_MS);
				const said = (pattern: string) =>
					new RegExp(`\\(${sessionId}\\): a window${pattern}`).test(
						host.errors(),
					);
				// The journal comes on the host's stderr, apart from the frames.
				await until(
					"the journal to name what the attach waited on",
					() =>
						said(
							"'s attach has waited [0-9.]+ s, now on (the host's start to resume it|its wake)",
						),
					TURN_MS,
				);
				await until(
					"the journal to say when it was answered",
					() => said("'s attach was answered after [0-9.]+ s"),
					TURN_MS,
				);
			},
			CASE_MS * 2,
		);
	},
);

/** What connecting says of a host's socket before the host listens on it. */
const UNBOUND = ["ENOENT", "ECONNREFUSED"];

/**
 * A viewer attached through `path` once a host listens there, as a
 * window's attach is when it starts before the next host has bound it.
 */
async function attachOnceListening(
	path: string,
	sessionId: string,
): Promise<Viewer> {
	const deadline = Date.now() + CASE_MS;
	for (;;) {
		try {
			return await attach(path, sessionId, ROWS, COLUMNS);
		} catch (error) {
			// Only a socket nobody listens on yet is tried again: a host that
			// refuses the attach fails the case.
			const code = error instanceof Error ? Reflect.get(error, "code") : "";
			const unbound = UNBOUND.includes(String(code));
			if (!unbound || Date.now() > deadline) throw error;
			// Nothing outside the host says when it binds its socket, so the
			// attach tries again every REACH_EVERY_MS, as a window's loop does.
			await new Promise((done) => setTimeout(done, REACH_EVERY_MS));
		}
	}
}

/**
 * A fresh trusted folder whose own extension, allowed, holds its
 * conversation's start until GO_ON appears there: pi loads it as it
 * builds the conversation, after the host lists it and before its
 * screen exists.
 */
function heldAtStart(): string {
	const cwd = work.trusted();
	const extensions = join(cwd, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	writeFileSync(
		join(extensions, "held.ts"),
		`import { existsSync, writeFileSync } from "node:fs";
export default async function () {
	if (!existsSync(${JSON.stringify(join(cwd, GO_ON))}))
		writeFileSync(${JSON.stringify(join(cwd, HOLDING))}, "");
	while (!existsSync(${JSON.stringify(join(cwd, GO_ON))}))
		// Nothing tells an extension a file appeared, so it looks every 50 ms.
		await new Promise((done) => setTimeout(done, 50));
}
`,
	);
	return work.allowCode(cwd);
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
