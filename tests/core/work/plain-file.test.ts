/**
 * Reading git's small files only when they are plain, against real
 * files, links, folders and fifos.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPlain } from "../../../lib/core/work/plain-file.ts";
import { type LateWriter, lateWriter } from "../../support/late-writer.ts";

let root = "";
const writers: LateWriter[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "plain-file-"));
});
afterEach(() => {
	for (const writer of writers.splice(0)) writer.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("readPlain", () => {
	it("reads a plain file", () => {
		writeFileSync(join(root, "locked"), "initializing\n");

		expect(readPlain(join(root, "locked"))).toBe("initializing\n");
	});

	it("reads nothing where nothing stands", () => {
		expect(readPlain(join(root, "locked"))).toBeUndefined();
	});

	it("reads nothing through a link, which git never writes", () => {
		writeFileSync(join(root, "elsewhere"), "on a drive away\n");
		symlinkSync(join(root, "elsewhere"), join(root, "locked"));

		expect(readPlain(join(root, "locked"))).toBeUndefined();
	});

	it("reads nothing from a folder", () => {
		mkdirSync(join(root, "locked"));

		expect(readPlain(join(root, "locked"))).toBeUndefined();
	});

	it("reads nothing from a fifo, never waiting for its writer", () => {
		writers.push(lateWriter(join(root, "locked"), "on a drive away"));

		expect(readPlain(join(root, "locked"))).toBeUndefined();
	});

	it("reads no more than the start of a file grown huge", () => {
		writeFileSync(join(root, "gitdir"), "x".repeat(1 << 20));

		expect(readPlain(join(root, "gitdir"))).toHaveLength(4096);
	});
});
