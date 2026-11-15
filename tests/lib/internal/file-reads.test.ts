import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileReads } from "../../../lib/internal/file-reads.ts";

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "file-reads-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

describe("what a folder's files said", () => {
	it("answers what a file said while it is unchanged", async () => {
		const path = join(folder, "a.json");
		writeFileSync(path, "one");
		const reads = fileReads<string>("test-said", folder);
		reads.keep(path, await reads.stamp(path), "one");

		expect(reads.held(path, await reads.stamp(path))).toEqual({ said: "one" });
	});

	it("finds what another copy of the module kept", async () => {
		// A host loads each extension once per conversation's folder, and
		// each copy asks for the reads by name.
		const path = join(folder, "a.json");
		writeFileSync(path, "one");
		const first = fileReads<string>("test-shared", folder);
		first.keep(path, await first.stamp(path), "one");

		const second = fileReads<string>("test-shared", folder);
		expect(second.held(path, await second.stamp(path))).toEqual({
			said: "one",
		});
	});

	it("keeps an answer of nothing apart from no answer", async () => {
		const path = join(folder, "torn.json");
		writeFileSync(path, "{ torn");
		const reads = fileReads<string | undefined>("test-nothing", folder);
		reads.keep(path, await reads.stamp(path), undefined);

		expect(reads.held(path, await reads.stamp(path))).toEqual({
			said: undefined,
		});
	});

	it("answers nothing once a write renames a new file over it", async () => {
		const path = join(folder, "a.json");
		writeFileSync(path, "one");
		const reads = fileReads<string>("test-renamed", folder);
		reads.keep(path, await reads.stamp(path), "one");

		writeFileSync(`${path}.tmp`, "two");
		renameSync(`${path}.tmp`, path);

		expect(reads.held(path, await reads.stamp(path))).toBeUndefined();
	});

	it("answers nothing once a file is edited in place", async () => {
		const path = join(folder, "a.json");
		writeFileSync(path, "one");
		const reads = fileReads<string>("test-edited", folder);
		reads.keep(path, await reads.stamp(path), "one");

		writeFileSync(path, "three");

		expect(reads.held(path, await reads.stamp(path))).toBeUndefined();
	});

	it("keeps nothing of a file it could not stamp", async () => {
		const path = join(folder, "gone.json");
		const reads = fileReads<string>("test-unstamped", folder);
		const seen = await reads.stamp(path);
		reads.keep(path, seen, "one");

		expect(seen).toBeUndefined();
		expect(reads.held(path, seen)).toBeUndefined();
	});

	it("forgets the files a listing no longer finds", async () => {
		const kept = join(folder, "kept.json");
		const gone = join(folder, "gone.json");
		writeFileSync(kept, "one");
		writeFileSync(gone, "two");
		const reads = fileReads<string>("test-listed", folder);
		const seenKept = await reads.stamp(kept);
		const seenGone = await reads.stamp(gone);
		reads.keep(kept, seenKept, "one");
		reads.keep(gone, seenGone, "two");

		reads.keepOnly(new Set([kept]));

		expect(reads.held(kept, seenKept)).toEqual({ said: "one" });
		expect(reads.held(gone, seenGone)).toBeUndefined();
	});

	it("keeps what different callers read of one folder apart", async () => {
		const path = join(folder, "a.json");
		writeFileSync(path, "one");
		const rounds = fileReads<string>("test-rounds", folder);
		const fleets = fileReads<string>("test-fleets", folder);
		rounds.keep(path, await rounds.stamp(path), "rounds");

		expect(fleets.held(path, await fleets.stamp(path))).toBeUndefined();
	});
});
