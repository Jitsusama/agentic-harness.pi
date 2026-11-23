/**
 * What the calls carried read as when the disk fails for the moment, out
 * of descriptors or asked to try again: whom to spare is not known, so a
 * reap waits, where a fault of the path itself reads as nothing there;
 * and an end that fails so keeps the stray watch from no other stray.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carriedCalls } from "../../../../lib/internal/shell/kept.ts";
import {
	recordKeptJob,
	strayKeptJobs,
} from "../../../../lib/internal/shell/kept-jobs.ts";

/** The paths to fail, each with the code the machine would give. */
const faults = vi.hoisted(() => new Map<string, string>());

function faultAt(path: unknown): Error | undefined {
	const code = faults.get(String(path));
	return code === undefined
		? undefined
		: Object.assign(new Error(`${code}: as the test asked`), { code });
}

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const readFile = (async (...args: Parameters<typeof fs.readFile>) => {
		const fault = faultAt(args[0]);
		if (fault !== undefined) throw fault;
		return fs.readFile(...args);
	}) as typeof fs.readFile;
	const readdir = (async (...args: Parameters<typeof fs.readdir>) => {
		const fault = faultAt(args[0]);
		if (fault !== undefined) throw fault;
		return fs.readdir(...args);
	}) as typeof fs.readdir;
	return { ...fs, readFile, readdir };
});

let where: string;

/** A call handed on, as its shell's pid and its mark. */
function carried(name: string, mark: string, pid: number): void {
	writeFileSync(join(where, `${name}.pid`), `${pid}\n`);
	writeFileSync(join(where, `${name}.carried`), `${mark}\n`);
}

/** A job its session recorded, its call's files as a shell left them. */
function recorded(id: string): string {
	const keep = join(where, id);
	for (const suffix of [".out", ".end", ".pid"])
		writeFileSync(`${keep}${suffix}`, "");
	recordKeptJob({
		session: "s1",
		id,
		kind: "shell",
		label: `run ${id}`,
		owner: 88,
		work: { kind: "shell", keep, pid: 4242, mark: `mark-${id}`, startedAt: 0 },
	});
	return keep;
}

beforeEach(() => {
	where = mkdtempSync(join(tmpdir(), "kept-faults-"));
});

afterEach(() => {
	faults.clear();
	rmSync(where, { recursive: true, force: true });
});

describe("the calls carried, when the disk fails", () => {
	it.each([
		["a call's mark", "k1.carried"],
		["a call's pid", "k1.pid"],
	])("waits while %s fails to read for the moment", async (_what, name) => {
		carried("k1", "m1", 101);
		faults.set(join(where, name), "EMFILE");
		expect(
			(await carriedCalls(where, 0)).unread,
			"whom to spare is not known",
		).toBe(true);
	});

	it("waits while the folder fails to list for the moment", async () => {
		carried("k1", "m1", 101);
		faults.set(where, "EAGAIN");
		expect(
			(await carriedCalls(where, 0)).unread,
			"what is carried is not known",
		).toBe(true);
	});

	it("reads a file that fails for good as saying nothing, and reads the rest", async () => {
		carried("k1", "m1", 101);
		carried("k2", "m2", 102);
		faults.set(join(where, "k1.carried"), "EIO");
		const found = await carriedCalls(where, 0);
		expect(found.unread, "no reap waits on it").toBeUndefined();
		expect([...found.marks], "the rest still read").toEqual(["m2"]);
	});

	it("keeps the stray watch on the rest while one end fails to read for the moment", async () => {
		const unread = recorded("unread");
		recorded("stray");
		faults.set(`${unread}.end`, "EMFILE");
		expect(
			(await strayKeptJobs(where, () => false)).map((job) => job.id).sort(),
			"an end not read is an end not said",
		).toEqual(["stray", "unread"]);
	});

	it("reads a folder that fails to list for good as nothing carried", async () => {
		carried("k1", "m1", 101);
		faults.set(where, "EACCES");
		const found = await carriedCalls(where, 0);
		expect(found.unread, "no reap waits on it").toBeUndefined();
		expect(found.marks.size, "nothing in it is read").toBe(0);
	});
});
