import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isPidAlive,
	openSessionStore,
	reapAbandonedResults,
	sessionResultDir,
} from "../../../lib/result/location.js";

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

	it("removes a directory whose process is gone", () => {
		const dead = payloadDir(4242);

		reapAbandonedResults({ root, isPidAlive: () => false });

		expect(fs.existsSync(dead)).toBe(false);
	});

	it("leaves a live session's payloads alone", () => {
		const live = payloadDir(process.pid);

		reapAbandonedResults({ root, isPidAlive: (pid) => pid === process.pid });

		expect(fs.existsSync(live)).toBe(true);
	});

	it("does not touch directories it did not name", () => {
		const notOurs = path.join(root, "someone-elses-cache");
		fs.mkdirSync(notOurs);

		reapAbandonedResults({ root, isPidAlive: () => false });

		expect(fs.existsSync(notOurs)).toBe(true);
	});

	it("is quiet about a root that does not exist", () => {
		expect(() =>
			reapAbandonedResults({
				root: path.join(root, "never-created"),
				isPidAlive: () => false,
			}),
		).not.toThrow();
	});
});

describe("isPidAlive", () => {
	it("knows this process is running", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("knows a pid that cannot exist is not running", () => {
		// Above the platform maximum, so it is not a pid that could be
		// recycled between the check and the assertion.
		expect(isPidAlive(0x7fffffff)).toBe(false);
	});
});

describe("opening the session store", () => {
	it("names a directory without creating one", () => {
		const dir = sessionResultDir();
		const existedBefore = fs.existsSync(dir);

		openSessionStore();

		// Opening a store used to create its directory, which made
		// every seam's first act a disk write, performed outside the
		// one place that knows how to answer when a write fails. An
		// unwritable temp directory threw past all of it and cost the
		// caller an answer that had nothing to do with storage.
		if (!existedBefore) expect(fs.existsSync(dir)).toBe(false);
	});
});
