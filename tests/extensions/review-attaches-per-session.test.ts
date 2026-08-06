/**
 * What a session is working on is scoped to that session, wired up.
 *
 * The library has been able to do this for a while and had tests
 * proving it, all of which passed an explicit session id. The extension
 * passed `process.env.PI_SESSION_ID`, which pi injects when the bash
 * tool spawns a command and does not set in its own process, so the
 * argument was undefined every time and every session on the machine
 * went on sharing one directory. The fix was live for two merges before
 * anyone noticed, because nothing exercised the wiring.
 *
 * So this asserts the wiring: run the extension against a pi that
 * reports a session the way pi reports one, and see where an attachment
 * lands.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeRef } from "../../lib/review/index.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-session-"));
	process.env.XDG_STATE_HOME = root;
	// The variable the extension used to read. Set to something wrong on
	// purpose: if it is ever consulted again, the attachment lands under
	// this name and the assertion below says so.
	process.env.PI_SESSION_ID = "the-wrong-answer";
});

afterEach(() => {
	delete process.env.PI_SESSION_ID;
	delete process.env.XDG_STATE_HOME;
	rmSync(root, { recursive: true, force: true });
});

/**
 * A pi that records what was registered and answers anything else.
 *
 * Recursive, because an extension reaches through pi to plenty of
 * places on its way to the one thing under test, and none of those
 * journeys are what is being asserted.
 */
function fakePi(handlers: Map<string, (event: unknown, ctx: unknown) => void>) {
	const anything: unknown = new Proxy(() => {}, {
		get: () => anything,
		apply: () => anything,
	});
	const record = (name: string, h: (event: unknown, ctx: unknown) => void) => {
		handlers.set(name, h);
	};
	return new Proxy(() => {}, {
		get: (_target, prop) => {
			// Both, because pi has two: a lifecycle API that hands a handler
			// the context, and a bus that does not.
			if (prop === "on") return record;
			if (prop === "events")
				return { on: record, emit: () => {}, off: () => {} };
			return anything;
		},
		apply: () => anything,
		// biome-ignore lint/suspicious/noExplicitAny: a stand-in for pi's whole surface
	}) as any;
}

/** A context shaped the way pi shapes one, reporting this session. */
function contextFor(sessionId: string): unknown {
	return { sessionManager: { getSessionId: () => sessionId } };
}

function change(label: string): ChangeRef {
	return {
		provider: "github",
		repo: { key: "github:Jitsusama/agentic-harness.pi" },
		id: label,
		label,
	};
}

describe("the review extension", () => {
	it("attaches under the session pi says it is in", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const { default: reviewIntegration } = await import(
			"../../extensions/review-integration/index.js"
		);
		const { attachments } = await import(
			"../../extensions/review-integration/engine.js"
		);

		reviewIntegration(fakePi(handlers));
		handlers.get("session_start")?.({ reason: "startup" }, contextFor("s-1"));

		await attachments().attach(change("owner/repo#1"));

		const attachedRoot = join(
			root,
			"pi",
			"agentic-harness.pi",
			"review",
			"attached",
		);
		expect(await readdir(attachedRoot)).toEqual(["s-1"]);
	});

	it("keeps two sessions out of each other's way", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const { default: reviewIntegration } = await import(
			"../../extensions/review-integration/index.js"
		);
		const { attachments } = await import(
			"../../extensions/review-integration/engine.js"
		);

		reviewIntegration(fakePi(handlers));

		handlers.get("session_start")?.({ reason: "startup" }, contextFor("s-1"));
		await attachments().attach(change("owner/repo#1"));

		// The same extension instance, told it is now a different session,
		// which is what pi does on a resume or a fork.
		handlers.get("session_start")?.({ reason: "resume" }, contextFor("s-2"));
		await attachments().attach(change("owner/repo#2"));

		const mine = await attachments().list();
		expect(mine.map((a) => a.change.label)).toEqual(["owner/repo#2"]);
	});
});
