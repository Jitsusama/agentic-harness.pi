/**
 * The ssh guard's setting and the environment it gives a command: off,
 * nothing changes; on, the stand-ins lead PATH and name the machines.
 */

import { describe, expect, it, vi } from "vitest";
import {
	guardedEnvironment,
	machinesFrom,
	readSshGuard,
	refusesBySetting,
	SSH_GUARD_BIN,
	SSH_GUARD_HERE,
	SSH_GUARD_MACHINES,
	SSH_GUARD_OFF,
	type SshGuard,
	type SshGuardSources,
	watchSshGuard,
} from "../../../../lib/internal/shell/ssh-guard.ts";

const ON: SshGuard = {
	refuse: true,
	machines: ["optimus", "equilibrius"],
	here: "optimus",
};

const NAMED = JSON.stringify({
	Ok: { Machines: [{ name: "optimus" }, { name: "equilibrius" }] },
});

/** Sources saying `section`, the node answering `answer`, asked how often. */
function sources(section: unknown, answer: string | undefined) {
	const asked = { node: 0 };
	const said: SshGuardSources = {
		section: async () => section,
		machines: async () => {
			asked.node += 1;
			return answer;
		},
		here: "optimus",
	};
	return { said, asked };
}

describe("reading the guard", () => {
	it("is off without asking the node while the setting is off", async () => {
		const { said, asked } = sources(undefined, NAMED);
		expect(await readSshGuard(ON, said)).toBe(SSH_GUARD_OFF);
		expect(asked.node).toBe(0);
	});

	it("names the node's machines and this one while on", async () => {
		const { said } = sources({ refuse: true }, NAMED);
		expect(await readSshGuard(SSH_GUARD_OFF, said)).toEqual(ON);
	});

	it("keeps the machines read before when the node doesn't answer, and this one always", async () => {
		const { said } = sources({ refuse: true }, undefined);
		expect((await readSshGuard(ON, said)).machines).toEqual([
			"optimus",
			"equilibrius",
		]);
		expect((await readSshGuard(SSH_GUARD_OFF, said)).machines).toEqual([
			"optimus",
		]);
	});

	it("keeps the machines read before when the node answers naming none", async () => {
		for (const answer of [
			JSON.stringify({ Err: "busy" }),
			JSON.stringify({ Ok: { Other: [] } }),
			"not json",
		]) {
			const erring: SshGuardSources = {
				section: async () => ({ refuse: true }),
				machines: async () => answer,
				here: "optimus",
			};
			expect((await readSshGuard(ON, erring)).machines, answer).toEqual([
				"optimus",
				"equilibrius",
			]);
		}
	});

	it("throws when the config can't be read, so a watch keeps the guard", async () => {
		const unread: SshGuardSources = {
			section: async () => {
				throw new Error("half written");
			},
			machines: async () => NAMED,
			here: "optimus",
		};
		await expect(readSshGuard(ON, unread)).rejects.toThrow("half written");
	});
});

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
		expect(guarded[SSH_GUARD_HERE]).toBe("optimus");
		expect(guarded.HOME).toBe("/h");
		expect(guardedEnvironment({}, ON).PATH).toBe(SSH_GUARD_BIN);
	});

	it("is left as it was under the strict sandbox, which could run no stand-in", () => {
		const env = { PATH: "/bin" };
		expect(guardedEnvironment(env, ON, "strict")).toBe(env);
		expect(guardedEnvironment(env, ON, "fence").PATH).toBe(
			`${SSH_GUARD_BIN}:/bin`,
		);
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

	it("says a setting it can't read once, until a read lands again", async () => {
		const said: string[] = [];
		let next: Promise<SshGuard> = Promise.reject(new Error("bad JSON"));
		const watch = watchSshGuard(
			() => next,
			60_000,
			(why) => said.push(why),
		);
		const settle = async () => {
			await next.catch(() => undefined);
			await Promise.resolve();
		};
		watch.start();
		await settle();
		watch.start();
		await settle();
		expect(said, "said once").toEqual([
			"The ssh guard's setting can't be read, so it stays off: bad JSON",
		]);
		next = Promise.resolve(ON);
		watch.start();
		await settle();
		next = Promise.reject(new Error("bad again"));
		watch.start();
		await settle();
		expect(said[1], "said again after a read landed").toBe(
			"The ssh guard's setting can't be read, so it stays on: bad again",
		);
		watch.stop();
	});

	it("reads again each minute until stopped, dropping a read that lands late", async () => {
		vi.useFakeTimers();
		try {
			const reads: ((guard: SshGuard) => void)[] = [];
			const watch = watchSshGuard(
				() => new Promise<SshGuard>((resolve) => reads.push(resolve)),
				60_000,
			);
			watch.start();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(reads.length).toBe(2);
			reads[1]?.(ON);
			await vi.advanceTimersByTimeAsync(0);
			reads[0]?.(SSH_GUARD_OFF);
			await vi.advanceTimersByTimeAsync(0);
			expect(watch.current()).toBe(ON);
			watch.stop();
			await vi.advanceTimersByTimeAsync(120_000);
			expect(reads.length).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
