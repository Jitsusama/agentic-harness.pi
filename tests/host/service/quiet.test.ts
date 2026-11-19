/**
 * What holds a host's restart for the person: a call on, a meeting near,
 * read from the probes the unit names.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quietFrom } from "../../../host/service/quiet.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "quiet-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

// A probe that exits with `code`, or sleeps past any wait for "hang".
async function probe(name: string, code: number | "hang"): Promise<string> {
	const path = join(dir, name);
	await writeFile(
		path,
		`#!/bin/sh\n${code === "hang" ? "exec sleep 30" : `exit ${code}`}\n`,
	);
	await chmod(path, 0o755);
	return path;
}

describe("quietFrom", () => {
	it("asks nothing when the unit names no probes", () => {
		expect(quietFrom(undefined)).toBeUndefined();
		expect(quietFrom("")).toBeUndefined();
	});

	it("is clear only when every probe exits 1", async () => {
		const call = await probe("call", 1);
		const meeting = await probe("meeting", 1);
		const quiet = quietFrom(
			JSON.stringify([
				{ while: "a call is on", run: [call] },
				{ while: "a meeting is near", run: [meeting, "--calendar"] },
			]),
		);
		expect(await quiet?.()).toBeUndefined();
	});

	it.each([
		[0, "a meeting is near"],
		[2, "a meeting is near"],
	])("holds while a probe exits %d", async (code, why) => {
		const call = await probe("call", 1);
		const meeting = await probe("meeting", code);
		const quiet = quietFrom(
			JSON.stringify([
				{ while: "a call is on", run: [call] },
				{ while: "a meeting is near", run: [meeting] },
			]),
		);
		expect(await quiet?.()).toBe(why);
	});

	it("names every probe that holds it", async () => {
		const call = await probe("call", 0);
		const meeting = await probe("meeting", 0);
		const quiet = quietFrom(
			JSON.stringify([
				{ while: "a call is on", run: [call] },
				{ while: "a meeting is near", run: [meeting] },
			]),
		);
		expect(await quiet?.()).toBe("a call is on, and a meeting is near");
	});

	it("can't tell when a probe doesn't answer in time", async () => {
		const call = await probe("call", "hang");
		const quiet = quietFrom(
			JSON.stringify([{ while: "a call is on", run: [call] }]),
			{ answerMs: 100 },
		);
		await expect(quiet?.()).rejects.toThrow(/didn't answer within 100 ms/);
	});

	it("can't tell when a probe won't run", async () => {
		const quiet = quietFrom(
			JSON.stringify([{ while: "a call is on", run: [join(dir, "missing")] }]),
		);
		await expect(quiet?.()).rejects.toThrow(/missing/);
	});

	it("can't tell when the probes it names don't read as probes", async () => {
		const quiet = quietFrom('[{"while": 3}]');
		await expect(quiet?.()).rejects.toThrow(/PI_HOST_RESTART_WAITS_ON/);
	});
});
