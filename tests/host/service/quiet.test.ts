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

// A probe that exits with `code`, sleeps past any wait for "hang", or
// runs the shell given.
async function probe(
	name: string,
	code: number | "hang" | { sh: string },
): Promise<string> {
	const path = join(dir, name);
	const body =
		code === "hang"
			? "exec sleep 30"
			: typeof code === "number"
				? `exit ${code}`
				: code.sh;
	await writeFile(path, `#!/bin/sh\n${body}\n`);
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

	it("holds while a probe exits 0", async () => {
		const call = await probe("call", 1);
		const meeting = await probe("meeting", 0);
		const quiet = quietFrom(
			JSON.stringify([
				{ while: "a call is on", run: [call] },
				{ while: "a meeting is near", run: [meeting] },
			]),
		);
		expect(await quiet?.()).toBe("a meeting is near");
	});

	it("can't tell when a probe exits neither 0 nor 1, naming the exit", async () => {
		const meeting = await probe("meeting", 2);
		const quiet = quietFrom(
			JSON.stringify([{ while: "a meeting is near", run: [meeting] }]),
		);
		await expect(quiet?.()).rejects.toThrow(
			/exited 2, which says neither way whether a meeting is near/,
		);
	});

	it("runs each probe with the arguments the unit names", async () => {
		const meeting = await probe("meeting", {
			sh: '[ "$1" = /calls ] && [ "$2" = /off ] && exit 1; exit 0',
		});
		const quiet = quietFrom(
			JSON.stringify([
				{ while: "a meeting is near", run: [meeting, "/calls", "/off"] },
			]),
		);
		expect(await quiet?.()).toBeUndefined();
	});

	// A probe that saw NOTIFY_SOCKET could tell systemd the host is ready,
	// or feed its watchdog, while the host's own loop is held.
	it("keeps systemd's hand-over to the host from its probes", async () => {
		const call = await probe("call", {
			sh: '[ -z "$NOTIFY_SOCKET$WATCHDOG_USEC$LISTEN_FDS" ] && [ "$KEPT" = yes ] && exit 1; exit 0',
		});
		const quiet = quietFrom(
			JSON.stringify([{ while: "a call is on", run: [call] }]),
			{
				env: {
					PATH: process.env.PATH,
					KEPT: "yes",
					NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
					WATCHDOG_USEC: "600000000",
					LISTEN_FDS: "1",
				},
			},
		);
		expect(await quiet?.()).toBeUndefined();
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
