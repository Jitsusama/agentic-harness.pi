/** Plain pi parity and hosted isolation through the public session seam. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOwner, ownerStanding } from "../../../lib/core/process/index.ts";
import {
	ambientSession,
	endSession,
	type Host,
	type HostedState,
	type HostRegistry,
	hosted,
	hostRegistryPath,
	installHost,
	launchHints,
	NoSessionInHost,
	releaseSession,
	type SessionEnvironment,
	type SessionOwner,
	sessionCell,
	sessionCwd,
	sessionEnv,
	sessionKeyOf,
	sessionOwner,
	sessionSlot,
	withSession,
} from "../../../lib/core/session/index.ts";
import { processGlobal } from "../../../lib/internal/process-global.ts";
import {
	askedOnceWithTicks,
	processKey,
	type TickFacts,
	tickedOwnerNow,
	tickedStanding,
} from "../../../lib/internal/process-ticks.ts";

const OWNER: SessionOwner = {
	pid: 123,
	startedAt: 1000,
	bootId: "boot",
	startTicks: 20,
};
const FACTS: TickFacts = {
	alive: () => true,
	startedAt: async () => OWNER.startedAt,
	bootId: () => OWNER.bootId,
	startTicks: async () => OWNER.startTicks,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups
		.splice(0)
		.reverse()
		.forEach((cleanup) => {
			cleanup();
		});
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function context(id: string) {
	return {
		cwd: `/conversation/${id}`,
		sessionManager: { getSessionId: () => id },
	};
}

function fakeHost() {
	const states = new Map<string, HostedState>([
		["a", "busy"],
		["b", "idle"],
	]);
	const environments = new Map<string, SessionEnvironment>();
	const hints = new Map([["a", { questId: "quest-a", firstWords: "start a" }]]);
	const close = vi.fn((id: string) => {
		states.delete(id);
	});
	const host: Host = {
		kind: "pi-durable",
		key: "host",
		owner: OWNER,
		holds: (id) => states.get(id),
		env: (id) => {
			let env = environments.get(id);
			if (!env) {
				const values: NodeJS.ProcessEnv = { PI_SESSION_ID: id };
				env = {
					get: (name) => values[name],
					set: (name, value) => {
						values[name] = value;
					},
					delete: (name) => {
						delete values[name];
					},
					snapshot: () => ({ ...values }),
				};
				environments.set(id, env);
			}
			return env;
		},
		hints: (id) => {
			const hint = hints.get(id) ?? {};
			hints.delete(id);
			return hint;
		},
		close,
		stamp: vi.fn(),
	};
	cleanups.push(installHost(host));
	cleanups.push(() => {
		releaseSession("a");
		releaseSession("b");
	});
	return { host, states, close };
}

describe("plain pi", () => {
	it("keeps a legacy process slot across explicit and ambient session changes", () => {
		const name = `session-test/${randomUUID()}`;
		const original = processGlobal(name, () => ({ count: 1 }));
		cleanups.push(() => {
			Reflect.deleteProperty(globalThis, Symbol.for(name));
		});
		expect(hosted(), "pi installs no host").toBeUndefined();
		expect(
			sessionSlot(name, context("a"), () => ({})),
			"same process symbol",
		).toBe(original);
		expect(
			withSession("b", () => sessionSlot(name, undefined, () => ({}))),
			"new sessions and rollovers preserve the old slot",
		).toBe(original);
	});

	it("creates falsy slots only once", () => {
		const name = `session-test/${randomUUID()}`;
		const create = vi.fn(() => undefined);
		cleanups.push(() => {
			Reflect.deleteProperty(globalThis, Symbol.for(name));
		});
		sessionSlot(name, undefined, create);
		sessionSlot(name, undefined, create);
		releaseSession("a");
		sessionSlot(name, undefined, create);
		expect(
			create,
			"undefined is a stored value and pi release does nothing",
		).toHaveBeenCalledTimes(1);
	});

	it("keeps a cell as the bare value under its process symbol, absent once cleared", () => {
		const name = `session-test/${randomUUID()}`;
		const symbol = Symbol.for(name);
		const store = globalThis as Record<symbol, unknown>;
		cleanups.push(() => {
			Reflect.deleteProperty(globalThis, symbol);
		});
		const left = { by: "older code" };
		store[symbol] = left;
		const cell = sessionCell<object>(name, context("a"));
		expect(cell.get(), "what older code left is read as it stands").toBe(left);
		const mine = { by: "this code" };
		withSession("b", () => sessionCell<object>(name).set(mine));
		expect(store[symbol], "written bare, as older code reads it").toBe(mine);
		cell.clear();
		expect(symbol in store, "cleared means absent, not undefined").toBe(false);
	});

	it("reads and writes process.env while snapshots remain independent", () => {
		vi.stubEnv("SESSION_SEAM_TEST", "before");
		const env = sessionEnv();
		expect(env.get("SESSION_SEAM_TEST"), "reads today's env").toBe("before");
		env.set("SESSION_SEAM_TEST", "after");
		const snapshot = env.snapshot();
		snapshot.SESSION_SEAM_TEST = "copy";
		expect(
			process.env.SESSION_SEAM_TEST,
			"writes target process.env, not snapshot",
		).toBe("after");
		env.delete("SESSION_SEAM_TEST");
		expect(
			process.env.SESSION_SEAM_TEST,
			"deletes target process.env",
		).toBeUndefined();
	});

	it("consumes existing launch variables and leaves first words as a token", () => {
		vi.stubEnv("QUEST_WORKFLOW_AUTOLOAD_ID", "quest");
		vi.stubEnv("QUEST_WORKFLOW_ORCHESTRATE", "1");
		vi.stubEnv("QUEST_WORKFLOW_FIRST_WORDS", "token");
		expect(launchHints(), "same three startup hints").toEqual({
			questId: "quest",
			orchestrate: true,
			firstWordsToken: "token",
		});
		expect(launchHints().questId, "autoload consumed").toBeUndefined();
		expect(
			process.env.QUEST_WORKFLOW_FIRST_WORDS,
			"token consumed",
		).toBeUndefined();
	});

	it("takes the id and cwd from ctx and names the ordinary process owner", async () => {
		expect(sessionKeyOf(context("a")), "pi session id").toBe("a");
		expect(
			sessionCwd(context("a")),
			"ctx folder even when process.cwd differs",
		).toBe("/conversation/a");
		const owner = await sessionOwner();
		expect(owner?.pid, "ordinary pi owner").toBe(process.pid);
		expect(owner?.session, "no hosted identity").toBeUndefined();
		expect((await tickedOwnerNow())?.pid, "same existing owner API").toBe(
			owner?.pid,
		);
	});

	it("ends an ordinary owner with today's SIGTERM", async () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const owner = await sessionOwner();
		if (!owner) throw new Error("machine gave no process owner");
		await endSession(owner);
		expect(kill, "plain owner gets SIGTERM").toHaveBeenCalledWith(
			owner.pid,
			"SIGTERM",
		);
	});
});

describe("safe process ending", () => {
	it("refuses a reused pid or malformed hosted owner before SIGTERM", async () => {
		const owner = await sessionOwner();
		if (!owner) throw new Error("machine gave no process owner");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const stale = {
			...owner,
			startedAt: owner.startedAt + 100000,
			startTicks:
				owner.startTicks === undefined ? undefined : owner.startTicks + 1,
		};
		await expect(
			endSession(stale),
			"stale recorded owner is refused",
		).rejects.toThrow("gone");
		await expect(
			endSession({ ...owner, host: "host" }),
			"half hosted identity is refused",
		).rejects.toThrow("invalid owner");
		expect(
			kill.mock.calls.some(([, signal]) => signal === "SIGTERM"),
			"no termination signal reaches a reused pid",
		).toBe(false);
	});
});

describe("hosted sessions", () => {
	it("keys by explicit ctx before ambient context and frees only the closed session", () => {
		fakeHost();
		const name = "slot";
		const a = sessionSlot(name, "a", () => ({ count: 1 }));
		const b = sessionSlot(name, "b", () => ({ count: 2 }));
		expect(a, "different hosted session").not.toBe(b);
		expect(
			withSession("b", () => sessionSlot(name, context("a"), () => ({}))),
			"explicit context wins",
		).toBe(a);
		releaseSession("a");
		expect(
			sessionSlot(name, "a", () => ({})),
			"closed session slot freed",
		).not.toBe(a);
		expect(
			sessionSlot(name, "b", () => ({})),
			"sibling untouched",
		).toBe(b);
	});

	it("keeps a cell per conversation, freed only when that one closes", () => {
		fakeHost();
		const name = `cell-test/${randomUUID()}`;
		const a = sessionCell<string>(name, "a");
		const b = sessionCell<string>(name, context("b"));
		a.set("A");
		expect(b.get(), "A's value is invisible to B").toBeUndefined();
		b.set("B");
		expect(
			withSession("a", () => sessionCell<string>(name).get()),
			"the ambient conversation reads its own",
		).toBe("A");
		expect(
			Symbol.for(name) in globalThis,
			"nothing is left on the process",
		).toBe(false);
		releaseSession("a");
		expect(a.get(), "A's cell goes with A").toBeUndefined();
		expect(b.get(), "B survives A's close").toBe("B");
		b.clear();
		expect(b.get(), "cleared").toBeUndefined();
		expect(
			() => sessionCell(name),
			"a cell outside any conversation is refused",
		).toThrow(NoSessionInHost);
	});

	it("shares slots and ambient context across independently loaded library copies", async () => {
		fakeHost();
		vi.resetModules();
		const other = await import("../../../lib/core/session/index.ts");
		const a = withSession("a", () => {
			expect(other.ambientSession(), "copies share ALS").toBe("a");
			return other.sessionSlot("copy-slot", undefined, () => ({}));
		});
		expect(
			sessionSlot("copy-slot", "a", () => ({})),
			"copies share keyed slots",
		).toBe(a);
	});

	it("propagates context through promises and callbacks without crossing siblings", async () => {
		fakeHost();
		const seen = await Promise.all(
			["a", "b"].map((id) =>
				withSession(id, async () => {
					await setImmediate();
					return [ambientSession(), sessionEnv().get("PI_SESSION_ID")];
				}),
			),
		);
		expect(seen, "interleaved calls retain their own session").toEqual([
			["a", "a"],
			["b", "b"],
		]);
		expect(ambientSession(), "context restored on return").toBeUndefined();
	});

	it("refuses missing context for every ambient-only hosted API", async () => {
		fakeHost();
		expect(
			() => sessionSlot("missing", undefined, () => ({})),
			"missing slot key",
		).toThrow(NoSessionInHost);
		expect(() => sessionEnv(), "missing environment key").toThrow(
			NoSessionInHost,
		);
		expect(() => launchHints(), "missing launch key").toThrow(NoSessionInHost);
		await expect(sessionOwner(), "missing owner key").rejects.toThrow(
			NoSessionInHost,
		);
	});

	it("keeps environment and launch hints separate from siblings and the process", () => {
		fakeHost();
		vi.stubEnv("SESSION_SEAM_TEST", "host");
		const a = sessionEnv(context("a"));
		a.set("SESSION_SEAM_TEST", "a");
		sessionEnv("b").set("SESSION_SEAM_TEST", "b");
		expect(a.get("SESSION_SEAM_TEST"), "A keeps its environment").toBe("a");
		expect(process.env.SESSION_SEAM_TEST, "process untouched").toBe("host");
		a.snapshot().SESSION_SEAM_TEST = "copy";
		a.delete("SESSION_SEAM_TEST");
		expect(
			sessionEnv("b").get("SESSION_SEAM_TEST"),
			"A's delete leaves B alone",
		).toBe("b");
		expect(
			launchHints("a").firstWords,
			"host supplies literal first words",
		).toBe("start a");
		expect(launchHints("a"), "host consumes hints once").toEqual({});
		expect(launchHints("b"), "B never receives A's hints").toEqual({});
	});

	it("names a session owner and judges close independently from its live host", async () => {
		const { states, close } = fakeHost();
		const a = await sessionOwner("a");
		const b = await sessionOwner("b");
		expect(a, "host identity plus session").toEqual({
			...OWNER,
			session: "a",
			host: "host",
		});
		if (!a || !b) throw new Error("fake host gave no owner");
		expect(processKey(a), "keys do not collapse co-hosted sessions").not.toBe(
			processKey(b),
		);
		expect(await tickedStanding(a, FACTS), "open A").toBe("running");
		states.set("a", "parked");
		expect(await ownerStanding(a, FACTS), "parked is still held").toBe(
			"running",
		);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		await endSession(a, "concluded");
		expect(close, "close target only").toHaveBeenCalledWith("a", "concluded");
		expect(kill, "never signal a shared host").not.toHaveBeenCalled();
		expect(await tickedStanding(a, FACTS), "A closed").toBe("gone");
		expect(await tickedStanding(b, FACTS), "B remains").toBe("running");
		expect(
			await tickedStanding(b, { ...FACTS, startTicks: async () => 99 }),
			"reused pid cannot pass on registry alone",
		).toBe("gone");
		await expect(
			endSession({ ...a, startTicks: 99 }),
			"never close through a different process wearing the pid",
		).rejects.toThrow("control socket");
	});

	it("allows only one installed host and validates paired host/session owner fields", () => {
		const { host } = fakeHost();
		expect(() => installHost(host), "one host per process").toThrow(
			"already installed",
		);
		expect(
			isOwner({ ...OWNER, session: "a" }),
			"half a hosted identity is invalid",
		).toBe(false);
		expect(
			isOwner({ ...OWNER, session: "a", host: "host" }),
			"complete hosted identity",
		).toBe(true);
		expect(isOwner(OWNER), "legacy owners remain valid").toBe(true);
	});
});

describe("host lists read outside the host", () => {
	it("uses one registry snapshot per operation, and supports owners with no ticks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-host-snapshot-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		vi.stubEnv("XDG_STATE_HOME", dir);
		const processOwner = {
			pid: OWNER.pid,
			startedAt: OWNER.startedAt,
			bootId: OWNER.bootId,
		};
		const a = { ...processOwner, host: "host", session: "a" };
		const b = { ...a, session: "b" };
		const path = hostRegistryPath(a);
		mkdirSync(dirname(path), { recursive: true });
		const registry: HostRegistry = {
			key: "host",
			owner: processOwner,
			sessions: ["a", "b"].map((id) => ({
				id,
				state: "idle",
				since: new Date(0).toISOString(),
			})),
		};
		writeFileSync(path, JSON.stringify(registry));
		const snapshot = askedOnceWithTicks(FACTS);
		expect(
			await tickedStanding(a, snapshot),
			"no ticks falls back to wall-clock and list",
		).toBe("running");
		writeFileSync(path, JSON.stringify({ ...registry, sessions: [] }));
		expect(
			await tickedStanding(b, snapshot),
			"same operation sees its first whole list",
		).toBe("running");
		expect(
			await tickedStanding(b, askedOnceWithTicks(FACTS)),
			"next operation reads the close",
		).toBe("gone");
		rmSync(path);
		expect(
			await tickedStanding(a, FACTS),
			"no ticks and no list is unknown",
		).toBe("unknown");
		expect(
			await ownerStanding(a, FACTS),
			"wall-clock and no list is unknown",
		).toBe("unknown");
	});

	it("reads open, closed and unknown without guessing from a living pid", async () => {
		const dir = mkdtempSync(join(tmpdir(), "session-host-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		vi.stubEnv("XDG_STATE_HOME", dir);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const owner = { ...OWNER, session: "a", host: "host" };
		const path = hostRegistryPath(owner);
		mkdirSync(dirname(path), { recursive: true });
		expect(
			await tickedStanding(owner, FACTS),
			"missing registry is undecidable",
		).toBe("unknown");
		const registry: HostRegistry = {
			key: "host",
			owner: OWNER,
			sessions: [{ id: "a", state: "idle", since: new Date(0).toISOString() }],
		};
		writeFileSync(path, JSON.stringify(registry));
		expect(await tickedStanding(owner, FACTS), "list holds A").toBe("running");
		expect(
			await ownerStanding(owner, FACTS),
			"wall-clock owner API also checks list",
		).toBe("running");
		writeFileSync(path, JSON.stringify({ ...registry, sessions: [] }));
		expect(
			await tickedStanding(owner, FACTS),
			"whole list proves A closed",
		).toBe("gone");
		expect(
			await ownerStanding(owner, FACTS),
			"wall-clock list proves A closed",
		).toBe("gone");
		writeFileSync(path, "{");
		expect(
			await ownerStanding(owner, FACTS),
			"wall-clock malformed list is unknown",
		).toBe("unknown");
		expect(
			await tickedStanding(owner, FACTS),
			"torn list cannot end a session",
		).toBe("unknown");
		writeFileSync(path, JSON.stringify({ ...registry, key: "another" }));
		expect(
			await tickedStanding(owner, FACTS),
			"wrong host's list ignored",
		).toBe("unknown");
		writeFileSync(
			path,
			JSON.stringify({ ...registry, owner: { ...OWNER, bootId: "other" } }),
		);
		expect(await tickedStanding(owner, FACTS), "wrong boot ignored").toBe(
			"unknown",
		);
		for (const bad of [
			{ id: "b", state: ["idle"], since: new Date(0).toISOString() },
			{ id: "", state: "idle", since: new Date(0).toISOString() },
			{ id: "b", state: "idle", since: "not a date" },
		]) {
			writeFileSync(path, JSON.stringify({ ...registry, sessions: [bad] }));
			expect(
				await tickedStanding(owner, FACTS),
				"malformed entry cannot prove A closed",
			).toBe("unknown");
		}
		await expect(
			endSession(owner),
			"remote close never signals the host",
		).rejects.toThrow("control socket");
		expect(
			kill,
			"fake remote pid never reaches the machine",
		).not.toHaveBeenCalled();
	});
});
