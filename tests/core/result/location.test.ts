import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isPidAlive,
	openSessionStore,
	RESULT_ROOT,
	reapAbandonedResults,
	sessionResultDir,
} from "../../../lib/core/result/location.ts";
import { resultSession } from "../../support/result-session.ts";

const ctx = resultSession();

describe("reapAbandonedResults", () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-"));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** A payload directory named for a pid, with something in it. */
	function payloadDir(pid: number): string {
		const dir = path.join(root, String(pid));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "result-0000000000000000.json"), "{}");
		return dir;
	}

	it("removes a legacy directory whose process is gone", async () => {
		const dead = payloadDir(4242);
		fs.mkdirSync(path.join(dead, "session-a"));
		fs.writeFileSync(path.join(dead, "session-a", "payload.json"), "{}");
		fs.mkdirSync(path.join(dead, "session-b"));

		await reapAbandonedResults({
			root,
			legacyRoots: [root],
			isPidAlive: () => false,
		});

		expect(fs.existsSync(dead), `${dead} is removed`).toBe(false);
	});

	it("leaves a live session's legacy payloads alone", async () => {
		const live = payloadDir(process.pid);

		await reapAbandonedResults({
			root,
			legacyRoots: [root],
			isPidAlive: (pid) => pid === process.pid,
		});

		expect(fs.existsSync(live), `${live} is kept`).toBe(true);
	});

	it("does not touch directories it did not name", async () => {
		const notOurs = path.join(root, "someone-elses-cache");
		fs.mkdirSync(notOurs);

		await reapAbandonedResults({
			root,
			legacyRoots: [root],
			isPidAlive: () => false,
		});

		expect(fs.existsSync(notOurs), `${notOurs} is kept`).toBe(true);
	});

	it("is quiet about a root that does not exist", async () => {
		await expect(
			reapAbandonedResults({
				root: path.join(root, "never-created"),
				isPidAlive: () => false,
			}),
		).resolves.toBeUndefined();
	});
});

describe("isPidAlive", () => {
	it("knows this process is running", () => {
		expect(
			isPidAlive(process.pid),
			`this process, ${process.pid}, reads as alive`,
		).toBe(true);
	});

	it("knows a pid that cannot exist is not running", () => {
		// Above the platform maximum, so it is not a pid that could be
		// recycled between the check and the assertion.
		expect(
			isPidAlive(0x7fffffff),
			"a pid above the maximum reads as gone",
		).toBe(false);
	});
});

describe("opening the session store", () => {
	it("names each session independently of its process", () => {
		expect(sessionResultDir(ctx)).toBe(
			path.join(RESULT_ROOT, ctx.sessionManager.getSessionId()),
		);
		expect(sessionResultDir(resultSession())).not.toBe(sessionResultDir(ctx));
	});

	it("encodes separators rather than traversing outside the session root", () => {
		const sessionManager = ctx.sessionManager;
		const original = sessionManager.getSessionId;
		sessionManager.getSessionId = () => "../a/b";
		try {
			expect(path.basename(sessionResultDir(ctx))).toBe("..%2Fa%2Fb");
		} finally {
			sessionManager.getSessionId = original;
		}
	});

	it.each(["", ".", ".."])("refuses the unsafe session identity %j", (id) => {
		const sessionManager = ctx.sessionManager;
		const original = sessionManager.getSessionId;
		sessionManager.getSessionId = () => id;
		try {
			expect(() => sessionResultDir(ctx)).toThrow(
				"A result store needs a session id",
			);
		} finally {
			sessionManager.getSessionId = original;
		}
	});
	it("names a directory without creating one", () => {
		const dir = sessionResultDir(ctx);
		const existedBefore = fs.existsSync(dir);

		openSessionStore(ctx);

		// Opening a store used to create its directory, which made
		// every seam's first act a disk write, performed outside the
		// one place that knows how to answer when a write fails. An
		// unwritable temp directory threw past all of it and cost the
		// caller an answer that had nothing to do with storage.
		if (!existedBefore)
			expect(fs.existsSync(dir), `${dir} is not created`).toBe(false);
	});
});
