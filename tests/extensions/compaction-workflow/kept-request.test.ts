/**
 * The last request a session sent, kept on disk across a restart: it
 * comes back once, to the session it came from, while a cache could
 * still answer for it, and readable by nobody but its owner.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	KEPT_REQUEST_LIFETIME_MS,
	keepingRequests,
	saveKeptRequest,
	sweepKeptRequests,
	takeKeptRequest,
} from "../../../extensions/compaction-workflow/kept-request.ts";

const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

let dir: string;
beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), "kept-request-")), "requests");
});

const sent = (at = Date.now()) => ({
	payload: { messages: [{ role: "user", content: "go" }] },
	leafId: "u1",
	modelId: "claude-opus-5-5",
	at,
});

describe("a request kept across a restart", () => {
	it("comes back to the session it came from, once", async () => {
		const request = sent();
		await saveKeptRequest(dir, "s1", request);
		expect(takeKeptRequest(dir, "s1")).toEqual(request);
		expect(takeKeptRequest(dir, "s1")).toBeNull();
	});

	it("does not come back to another session", async () => {
		await saveKeptRequest(dir, "s1", sent());
		expect(takeKeptRequest(dir, "s2")).toBeNull();
	});

	it("is readable by its owner alone, and compressed", async () => {
		await saveKeptRequest(dir, "s1", sent());
		const [name] = readdirSync(dir);
		expect(name).toBe("s1.json.gz");
		const mode = statSync(join(dir, name ?? "")).mode & PERMISSION_BITS;
		expect(mode).toBe(OWNER_ONLY);
	});

	it("does not come back once no cache could answer for it", async () => {
		const now = Date.now();
		await saveKeptRequest(dir, "s1", sent(now - KEPT_REQUEST_LIFETIME_MS - 1));
		expect(takeKeptRequest(dir, "s1", now)).toBeNull();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("keeps a session id from naming a file outside its directory", async () => {
		await saveKeptRequest(dir, "../escape", sent());
		expect(readdirSync(dir)).toEqual([".._escape.json.gz"]);
		expect(takeKeptRequest(dir, "../escape")).not.toBeNull();
	});

	it("gives nothing back, and removes the file, when it will not read", async () => {
		await saveKeptRequest(dir, "s1", sent());
		writeFileSync(join(dir, "s1.json.gz"), "not gzip");
		expect(takeKeptRequest(dir, "s1")).toBeNull();
		const kept = join(dir, "s1.json.gz");
		expect(existsSync(kept), `${kept} is removed`).toBe(false);
	});

	it("gives nothing back, and removes the file, when a crash cut it short", async () => {
		await saveKeptRequest(dir, "s1", sent());
		const kept = join(dir, "s1.json.gz");
		const whole = readFileSync(kept);
		writeFileSync(kept, whole.subarray(0, Math.floor(whole.length / 2)));
		expect(takeKeptRequest(dir, "s1")).toBeNull();
		expect(existsSync(kept), `${kept} is removed`).toBe(false);
	});

	it("resolves rather than failing a shutdown when it can't be written", async () => {
		const blocked = join(dir, "..", "a-file");
		writeFileSync(blocked, "in the way");
		await expect(
			saveKeptRequest(blocked, "s1", sent()),
		).resolves.toBeUndefined();
	});

	it("sweeps away what a writer cut off left staged, once it is as old as a cache", () => {
		const writing = join(dir, ".writing");
		mkdirSync(writing, { recursive: true });
		writeFileSync(join(writing, "old.json.gz.1.ab"), "cut off");
		writeFileSync(join(writing, "new.json.gz.2.cd"), "being written");
		const long = (Date.now() - KEPT_REQUEST_LIFETIME_MS - 60_000) / 1000;
		utimesSync(join(writing, "old.json.gz.1.ab"), long, long);
		sweepKeptRequests(dir);
		expect(readdirSync(writing)).toEqual(["new.json.gz.2.cd"]);
	});

	it("sweeps away what is older than any cache, and leaves the rest", async () => {
		await saveKeptRequest(dir, "old", sent());
		await saveKeptRequest(dir, "new", sent());
		const long = (Date.now() - KEPT_REQUEST_LIFETIME_MS - 60_000) / 1000;
		utimesSync(join(dir, "old.json.gz"), long, long);
		sweepKeptRequests(dir);
		expect(readdirSync(dir)).toEqual(["new.json.gz"]);
	});

	it("sweeps nothing, without failing, when nothing was ever kept", () => {
		expect(() => sweepKeptRequests(dir)).not.toThrow();
	});

	it("is switched off by PI_COMPACTION_KEEP_REQUEST=off", () => {
		expect(keepingRequests({}), "unset keeps requests").toBe(true);
		expect(
			keepingRequests({ PI_COMPACTION_KEEP_REQUEST: "off" }),
			"off switches it off",
		).toBe(false);
		expect(
			keepingRequests({ PI_COMPACTION_KEEP_REQUEST: "OFF" }),
			"OFF switches it off too",
		).toBe(false);
	});
});
