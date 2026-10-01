/**
 * The last request a session sent, kept on disk across a restart: it
 * comes back once, to the session it came from, while a cache could
 * still answer for it, and readable by nobody but its owner.
 */

import {
	existsSync,
	mkdtempSync,
	readdirSync,
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
	it("comes back to the session it came from, once", () => {
		const request = sent();
		saveKeptRequest(dir, "s1", request);
		expect(takeKeptRequest(dir, "s1")).toEqual(request);
		expect(takeKeptRequest(dir, "s1")).toBeNull();
	});

	it("does not come back to another session", () => {
		saveKeptRequest(dir, "s1", sent());
		expect(takeKeptRequest(dir, "s2")).toBeNull();
	});

	it("is readable by its owner alone, and compressed", () => {
		saveKeptRequest(dir, "s1", sent());
		const [name] = readdirSync(dir);
		expect(name).toBe("s1.json.gz");
		const mode = statSync(join(dir, name ?? "")).mode & PERMISSION_BITS;
		expect(mode).toBe(OWNER_ONLY);
	});

	it("does not come back once no cache could answer for it", () => {
		const now = Date.now();
		saveKeptRequest(dir, "s1", sent(now - KEPT_REQUEST_LIFETIME_MS - 1));
		expect(takeKeptRequest(dir, "s1", now)).toBeNull();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("keeps a session id from naming a file outside its directory", () => {
		saveKeptRequest(dir, "../escape", sent());
		expect(readdirSync(dir)).toEqual([".._escape.json.gz"]);
		expect(takeKeptRequest(dir, "../escape")).not.toBeNull();
	});

	it("gives nothing back, and removes the file, when it will not read", () => {
		saveKeptRequest(dir, "s1", sent());
		writeFileSync(join(dir, "s1.json.gz"), "not gzip");
		expect(takeKeptRequest(dir, "s1")).toBeNull();
		expect(existsSync(join(dir, "s1.json.gz"))).toBe(false);
	});

	it("sweeps away what is older than any cache, and leaves the rest", () => {
		saveKeptRequest(dir, "old", sent());
		saveKeptRequest(dir, "new", sent());
		const long = (Date.now() - KEPT_REQUEST_LIFETIME_MS - 60_000) / 1000;
		utimesSync(join(dir, "old.json.gz"), long, long);
		sweepKeptRequests(dir);
		expect(readdirSync(dir)).toEqual(["new.json.gz"]);
	});

	it("sweeps nothing, without failing, when nothing was ever kept", () => {
		expect(() => sweepKeptRequests(dir)).not.toThrow();
	});

	it("is switched off by PI_COMPACTION_KEEP_REQUEST=off", () => {
		expect(keepingRequests({})).toBe(true);
		expect(keepingRequests({ PI_COMPACTION_KEEP_REQUEST: "off" })).toBe(false);
		expect(keepingRequests({ PI_COMPACTION_KEEP_REQUEST: "OFF" })).toBe(false);
	});
});
