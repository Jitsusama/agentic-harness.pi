/**
 * What a session is working on is scoped to that session, wired up.
 *
 * The library has been able to do this for a while and had tests
 * proving it, all of which passed an explicit session id. The extension
 * passed `process.env.PI_SESSION_ID`, which pi's bash tool sets on a
 * command it spawns after deleting any inherited value, so the variable
 * exists for a child and never in pi itself. The argument was undefined
 * every time, undefined means "no session to separate", and every
 * session on the machine went on sharing one directory for two merges.
 *
 * So this asserts the wiring rather than the seam, on pi's lifecycle
 * API specifically, because the bus the handler used to sit on carries
 * no context and never delivered the event at all.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachments } from "../../extensions/review-integration/engine.js";
import type { ChangeRef } from "../../lib/review/index.js";
import { activate } from "./support/review-extension.js";

let root: string;
let wasState: string | undefined;
let wasSession: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-session-"));
	wasState = process.env.XDG_STATE_HOME;
	wasSession = process.env.PI_SESSION_ID;
	process.env.XDG_STATE_HOME = root;
	// The variable the extension used to read. Wrong on purpose: if it
	// is ever consulted again, the attachment lands under this name and
	// the assertions below say so by name.
	process.env.PI_SESSION_ID = "the-wrong-answer";
});

afterEach(() => {
	if (wasSession === undefined) delete process.env.PI_SESSION_ID;
	else process.env.PI_SESSION_ID = wasSession;
	if (wasState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = wasState;
	rmSync(root, { recursive: true, force: true });
});

function change(label: string): ChangeRef {
	return {
		provider: "github",
		repo: { key: "github:Jitsusama/agentic-harness.pi" },
		id: label,
		label,
	};
}

/** Where attachments land under the sandboxed state directory. */
function attachedRoot(): string {
	return join(root, "pi", "agentic-harness.pi", "review", "attached");
}

/** Tell the extension it is in this session, the way pi tells it. */
function startSession(
	stub: ReturnType<typeof activate>,
	sessionId: string,
	event: Record<string, unknown> = { reason: "startup" },
): void {
	const started = stub.lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	started(event, { sessionManager: { getSessionId: () => sessionId } });
}

/**
 * A session file, as pi writes one.
 *
 * The name carries the id and so does the header, which is what makes
 * reading it worth doing rather than parsing the path.
 */
function sessionFile(id: string, headerId = id): string {
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-08-06T21-15-02-270Z_${id}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: headerId })}\n`,
		"utf8",
	);
	return path;
}

describe("the review extension", () => {
	it("attaches under the session pi says it is in", async () => {
		const stub = activate();
		startSession(stub, "s-1");

		await attachments().attach(change("owner/repo#1"));

		expect(await readdir(attachedRoot())).toEqual(["s-1"]);
	});

	it("keeps two sessions out of each other's way", async () => {
		const stub = activate();

		startSession(stub, "s-1");
		await attachments().attach(change("owner/repo#1"));

		// The same extension instance, told it is now a different
		// session, which is what pi does on a resume or a fork.
		startSession(stub, "s-2");
		await attachments().attach(change("owner/repo#2"));

		// What the second session sees, and, just as much the point,
		// that the first one still has what it attached. A reset that
		// wiped, or an attach that cleared the root before writing,
		// passes the first assertion and destroys the other session's
		// work. The incident this fixes had both halves.
		expect((await attachments().list()).map((a) => a.change.label)).toEqual([
			"owner/repo#2",
		]);
		expect((await readdir(attachedRoot())).sort()).toEqual(["s-1", "s-2"]);
	});

	it("gives back the directory of a session long gone", async () => {
		// Starting a session runs a sweep, which until this change had
		// never run at all. The test fires it either way, so it is
		// better asserted than left as an unobserved side effect.
		const stale = join(attachedRoot(), "s-ancient");
		mkdirSync(stale, { recursive: true });
		const when = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		utimesSync(stale, when, when);

		const stub = activate();
		startSession(stub, "s-now");

		// The sweep is deliberately not awaited by the session, so that
		// starting one is never delayed by housekeeping.
		await vi.waitFor(async () =>
			expect(await readdir(attachedRoot())).not.toContain("s-ancient"),
		);
	});

	it("carries what it was working on into a fork", async () => {
		// A fork is the same work continued, and pi mints it a new
		// session id, so scoping by session made every fork start with
		// nothing attached. Pi names the file it forked from, which is
		// the only thing that can say whose attachments these are.
		const stub = activate();
		startSession(stub, "s-parent");
		await attachments().attach(change("owner/repo#7"));

		startSession(stub, "s-fork", {
			reason: "fork",
			previousSessionFile: sessionFile("s-parent"),
		});

		await vi.waitFor(async () =>
			expect((await attachments().list()).map((a) => a.change.label)).toEqual([
				"owner/repo#7",
			]),
		);
		// And the session it forked from still has it: a fork is a copy.
		expect((await readdir(attachedRoot())).sort()).toEqual([
			"s-fork",
			"s-parent",
		]);
	});

	it("does not carry anything into a session that is merely new", async () => {
		// Pi names a previous file for a new session too, and a new
		// session is a fresh start rather than a continuation. Reading
		// the file without reading the reason would attach the last
		// session's work to somebody starting clean.
		const stub = activate();
		startSession(stub, "s-before");
		await attachments().attach(change("owner/repo#8"));

		startSession(stub, "s-after", {
			reason: "new",
			previousSessionFile: sessionFile("s-before"),
		});

		await vi.waitFor(async () =>
			expect(await readdir(attachedRoot())).toContain("s-before"),
		);
		expect(await attachments().list()).toEqual([]);
	});

	it("reads the parent's id from the file rather than from its name", async () => {
		// The name and the header agree in every file pi writes, and the
		// header is what pi itself reads. A file renamed by a person, or
		// a naming scheme that changes, must not silently inherit the
		// wrong session's work.
		const stub = activate();
		startSession(stub, "s-real-parent");
		await attachments().attach(change("owner/repo#9"));

		startSession(stub, "s-fork-2", {
			reason: "fork",
			previousSessionFile: sessionFile("renamed-by-hand", "s-real-parent"),
		});

		await vi.waitFor(async () =>
			expect((await attachments().list()).map((a) => a.change.label)).toEqual([
				"owner/repo#9",
			]),
		);
	});

	it("does not put a session with no name in with everyone else", async () => {
		// A host that never starts a session, and an ephemeral one that
		// has no id to give, both used to fall back to the shared
		// directory, which is the arrangement that retargeted a live
		// council. Anonymous is not the same as communal.
		const stub = activate();
		startSession(stub, "");

		await attachments().attach(change("owner/repo#3"));

		const [only] = await readdir(attachedRoot());
		expect(only).not.toBe("the-wrong-answer");
		expect(only).toMatch(/^process-/);
	});
});
