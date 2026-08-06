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

import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachments } from "../../extensions/review-integration/engine.js";
import type { ChangeRef } from "../../lib/review/index.js";
import { activate } from "./support/review-extension.js";

let root: string;
let wasState: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-session-"));
	wasState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = root;
	// The variable the extension used to read. Wrong on purpose: if it
	// is ever consulted again, the attachment lands under this name and
	// the assertions below say so by name.
	process.env.PI_SESSION_ID = "the-wrong-answer";
});

afterEach(() => {
	delete process.env.PI_SESSION_ID;
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
): void {
	const started = stub.lifecycle.get("session_start");
	if (started === undefined) {
		throw new Error("the extension registered no session_start on pi.on");
	}
	started(
		{ reason: "startup" },
		{ sessionManager: { getSessionId: () => sessionId } },
	);
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
