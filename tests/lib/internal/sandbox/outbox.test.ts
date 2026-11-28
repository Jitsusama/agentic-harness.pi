/**
 * Taking a strict session's outbox out takes only plain files, each held
 * by one name and within its size, and nothing a link, a FIFO or a
 * folder there would lead it to.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeOutbox } from "../../../../lib/internal/sandbox/outbox.ts";

let base: string;
let outbox: string;
let into: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "outbox-"));
	outbox = join(base, "outbox");
	into = join(base, "into");
	mkdirSync(outbox);
	mkdirSync(into);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A taking with room enough and time enough. */
const take = (most = 1024) =>
	takeOutbox(outbox, into, { most, deadline: Date.now() + 60_000 });

/** The entries a taking came to, failing the test when it was refused. */
function entries(taking: ReturnType<typeof takeOutbox>) {
	if ("refused" in taking) throw new Error(taking.refused);
	return taking.entries;
}

describe("taking a strict session's outbox", () => {
	it("copies a plain file, the taker's alone, with its size and sha-256", () => {
		writeFileSync(join(outbox, "result.patch"), "the work\n");
		expect(entries(take())).toEqual([
			{
				name: "result.patch",
				taken: true,
				bytes: 9,
				sha256: createHash("sha256").update("the work\n").digest("hex"),
			},
		]);
		expect(readFileSync(join(into, "result.patch"), "utf8")).toBe("the work\n");
		expect(statSync(join(into, "result.patch")).mode & 0o777).toBe(0o600);
	});

	it("refuses a link planted to a file outside, copying nothing of it", () => {
		const secret = join(base, "secret");
		writeFileSync(secret, "not the session's to hand back\n");
		symlinkSync(secret, join(outbox, "result.patch"));
		expect(entries(take())).toEqual([
			{ name: "result.patch", taken: false, why: "it isn't a plain file" },
		]);
		expect(existsSync(join(into, "result.patch"))).toBe(false);
	});

	it("refuses a hard link, which another name holds too", () => {
		const elsewhere = join(base, "elsewhere");
		writeFileSync(elsewhere, "held twice\n");
		linkSync(elsewhere, join(outbox, "twice"));
		expect(entries(take())).toEqual([
			{ name: "twice", taken: false, why: "it has another name, a hard link" },
		]);
	});

	it("refuses a FIFO without waiting on it", () => {
		execFileSync("mkfifo", [join(outbox, "pipe")]);
		expect(entries(take())).toEqual([
			{ name: "pipe", taken: false, why: "it isn't a plain file" },
		]);
	});

	it("walks no folder below it", () => {
		mkdirSync(join(outbox, "deeper"));
		writeFileSync(join(outbox, "deeper/file"), "x");
		expect(entries(take())).toEqual([
			{ name: "deeper", taken: false, why: "it isn't a plain file" },
		]);
		expect(existsSync(join(into, "deeper"))).toBe(false);
	});

	it("refuses a file past its size, taking the rest", () => {
		writeFileSync(join(outbox, "big"), "x".repeat(11));
		writeFileSync(join(outbox, "small"), "x");
		expect(entries(take(10))).toEqual([
			{ name: "big", taken: false, why: "it holds 11 bytes, more than 10" },
			expect.objectContaining({ name: "small", taken: true, bytes: 1 }),
		]);
	});

	it("never writes over a file already where its copy goes, nor through a link there", () => {
		writeFileSync(join(outbox, "kept"), "new");
		writeFileSync(join(into, "kept"), "old");
		const target = join(base, "target");
		writeFileSync(join(outbox, "linked"), "new");
		symlinkSync(target, join(into, "linked"));
		const taken = entries(take());
		expect(taken.map((entry) => [entry.name, entry.taken])).toEqual([
			["kept", false],
			["linked", false],
		]);
		expect(readFileSync(join(into, "kept"), "utf8")).toBe("old");
		expect(existsSync(target)).toBe(false);
	});

	it("takes nothing once its deadline has passed", () => {
		writeFileSync(join(outbox, "late"), "x");
		const taking = takeOutbox(outbox, into, { most: 10, deadline: 0 });
		expect(entries(taking)).toEqual([
			{ name: "late", taken: false, why: "the taking ran out of time" },
		]);
	});

	it("reads none when the outbox is a link, or the folder to take into is", () => {
		const real = join(base, "real");
		mkdirSync(real);
		writeFileSync(join(real, "file"), "x");
		rmSync(outbox, { recursive: true });
		symlinkSync(real, outbox);
		expect(take()).toEqual({
			refused: `the outbox ${outbox} is missing, a link or not a folder`,
		});
		rmSync(outbox);
		mkdirSync(outbox);
		rmSync(into, { recursive: true });
		symlinkSync(real, into);
		expect(take()).toEqual({
			refused: `the folder to take into ${into} is missing, a link or not a folder`,
		});
	});
});
