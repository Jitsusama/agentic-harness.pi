/**
 * The ssh guard's setting and the environment it gives a command: off,
 * nothing changes; on, the stand-ins lead PATH and name the machines.
 */

import { describe, expect, it } from "vitest";
import {
	guardedEnvironment,
	machinesFrom,
	refusesBySetting,
	SSH_GUARD_BIN,
	SSH_GUARD_MACHINES,
	SSH_GUARD_OFF,
	type SshGuard,
	watchSshGuard,
} from "../../../../lib/internal/shell/ssh-guard.ts";

const ON: SshGuard = { refuse: true, machines: ["optimus", "equilibrius"] };

describe("the ssh guard's setting", () => {
	it("refuses only when its section says refuse: true", () => {
		expect(refusesBySetting({ refuse: true }), "on").toBe(true);
		for (const section of [undefined, {}, { refuse: "true" }, true, []])
			expect(refusesBySetting(section), JSON.stringify(section)).toBe(false);
	});

	it("reads the machines a node names, and nothing from what it can't read", () => {
		const line = JSON.stringify({
			Ok: { Machines: [{ name: "optimus" }, { name: "equilibrius" }, {}] },
		});
		expect(machinesFrom(line)).toEqual(["optimus", "equilibrius"]);
		expect(machinesFrom(undefined)).toEqual([]);
		expect(machinesFrom("not json")).toEqual([]);
		expect(
			machinesFrom(JSON.stringify({ Ok: { Machines: [{ name: "a b" }] } })),
		).toEqual([]);
	});
});

describe("a command's environment under the guard", () => {
	it("is left as it was while the guard is off", () => {
		const env = { PATH: "/bin" };
		expect(guardedEnvironment(env, SSH_GUARD_OFF)).toBe(env);
		expect(guardedEnvironment(env, { refuse: true, machines: [] })).toBe(env);
	});

	it("leads PATH with the stand-ins once, naming the machines", () => {
		const env = { PATH: `${SSH_GUARD_BIN}:/usr/bin:/bin`, HOME: "/h" };
		const guarded = guardedEnvironment(env, ON);
		expect(guarded.PATH).toBe(`${SSH_GUARD_BIN}:/usr/bin:/bin`);
		expect(guarded[SSH_GUARD_MACHINES]).toBe("optimus equilibrius");
		expect(guarded.HOME).toBe("/h");
		expect(guardedEnvironment({}, ON).PATH).toBe(SSH_GUARD_BIN);
	});
});

describe("watching the guard", () => {
	it("is off until read, and keeps what it last read when a read fails", async () => {
		let next: Promise<SshGuard> = Promise.resolve(ON);
		const watch = watchSshGuard(() => next, 60_000);
		expect(watch.current()).toBe(SSH_GUARD_OFF);
		watch.start();
		await next;
		await Promise.resolve();
		expect(watch.current()).toBe(ON);
		next = Promise.reject(new Error("rewritten"));
		watch.start();
		await next.catch(() => undefined);
		await Promise.resolve();
		expect(watch.current()).toBe(ON);
		watch.stop();
	});
});
