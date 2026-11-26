/** Two hosted conversations share a process, never state or lifecycle. */
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ConversationRegistration,
	type HostChanges,
	SessionHost,
} from "../../../host/engine/index.ts";
import {
	ambientSession,
	endSession,
	hosted,
	launchHints,
	sessionEnv,
	sessionOwner,
	sessionSlot,
} from "../../../lib/core/session/index.ts";

const owner = { pid: 123, startedAt: 1000, bootId: "boot", startTicks: 20 };
const hosts: SessionHost[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const host of hosts.splice(0)) {
		for (const { id } of host.list()) await host.close(id);
		host.dispose();
	}
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function start(changes?: HostChanges) {
	const dir = mkdtempSync(join(tmpdir(), "session-engine-"));
	directories.push(dir);
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir: dir,
		...(changes ? { changes } : {}),
	});
	hosts.push(host);
	return host;
}

function registration(
	id: string,
	close: ConversationRegistration["close"] = () => {},
): ConversationRegistration {
	return {
		id,
		file: `/sessions/${id}.jsonl`,
		cwd: `/repo/${id}`,
		env: { MARKER: id },
		hints: { firstWords: `hello ${id}` },
		close,
	};
}

function blockPublication(host: SessionHost): () => void {
	const saved = `${host.registryPath}.saved`;
	fs.renameSync(host.registryPath, saved);
	fs.mkdirSync(host.registryPath);
	return () => {
		fs.rmSync(host.registryPath, { recursive: true });
		fs.renameSync(saved, host.registryPath);
	};
}

function registry(host: SessionHost) {
	return JSON.parse(readFileSync(host.registryPath, "utf8"));
}

it("installs ownership and publishes stable ids before extension loading", () => {
	const host = start();
	expect(hosted()).toBe(host);
	expect(registry(host)).toEqual({ key: "test-host", owner, sessions: [] });
	host.register(registration("a"));
	host.register(registration("b"));

	expect(host.list()).toMatchObject([
		{ id: "a", file: "/sessions/a.jsonl", cwd: "/repo/a", state: "idle" },
		{ id: "b", file: "/sessions/b.jsonl", cwd: "/repo/b", state: "idle" },
	]);
	expect(registry(host).sessions.map((s: { id: string }) => s.id)).toEqual([
		"a",
		"b",
	]);
	expect(fs.statSync(host.registryPath).mode & 0o777).toBe(0o600);
});

it("says a conversation is viewed as its screens do, and none without them", () => {
	const plain = start();
	expect(plain.viewed("a"), "a host with no screens").toBe(false);
	plain.dispose();
	hosts.splice(hosts.indexOf(plain), 1);
	const dir = mkdtempSync(join(tmpdir(), "session-engine-"));
	directories.push(dir);
	const watched = new Set(["a"]);
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir: dir,
		viewed: (id) => watched.has(id),
	});
	hosts.push(host);
	expect(hosted()?.viewed?.("a"), "one with a window on it").toBe(true);
	expect(host.viewed("b"), "one with none").toBe(false);
	watched.delete("a");
	expect(host.viewed("a"), "once its window has gone").toBe(false);
});

it("dispatches interleaved callbacks under separate environments and slots", async () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	const processId = process.env.PI_SESSION_ID;

	const observations = await Promise.all(
		["a", "b"].map((id) =>
			host.run(id, async () => {
				const slot = sessionSlot("engine-test", undefined, () => ({
					marker: id,
				}));
				await setImmediate();
				return [
					ambientSession(),
					sessionEnv().get("PI_SESSION_ID"),
					slot.marker,
				];
			}),
		),
	);

	expect(observations).toEqual([
		["a", "a", "a"],
		["b", "b", "b"],
	]);
	expect(process.env.PI_SESSION_ID).toBe(processId);
	expect(ambientSession()).toBeUndefined();
});

it("copies incoming environments and snapshots and consumes hints once", () => {
	const host = start();
	const input = registration("a");
	host.register(input);
	host.register(registration("b"));
	input.env.MARKER = "changed";
	expect(host.env("a").get("MARKER")).toBe("a");
	host.env("a").snapshot().MARKER = "copy";
	expect(host.env("a").get("MARKER")).toBe("a");
	host.env("a").set("MARKER", "a only");
	host.env("a").delete("MARKER");

	expect(host.env("a").get("MARKER")).toBeUndefined();
	expect(host.env("b").get("MARKER")).toBe("b");
	expect(host.run("a", () => launchHints())).toEqual({ firstWords: "hello a" });
	expect(host.hints("a")).toEqual({});
	expect(host.hints("b")).toEqual({ firstWords: "hello b" });
});

it("publishes changes in call order and protects list snapshots", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	host.state("a", "busy");
	host.state("b", "parked");
	host.state("a", "idle");
	host.list().splice(0);

	expect(
		registry(host).sessions.map((s: { state: string }) => s.state),
	).toEqual(["idle", "parked"]);
	expect(host.list()).toHaveLength(2);
	expect(
		fs
			.readdirSync(join(host.registryPath, ".."))
			.filter((name) => name.endsWith(".new")),
	).toEqual([]);
});

it("keeps when a conversation turned busy when it is said busy again", () => {
	vi.useFakeTimers({ now: Date.parse("2026-11-20T20:00:00Z") });
	try {
		const host = start();
		host.register(registration("a"));
		host.state("a", "busy");
		const began = host.list()[0]?.since;

		vi.setSystemTime(Date.parse("2026-11-20T20:40:00Z"));
		host.state("a", "busy");

		expect(host.list()[0]?.since, "still when it began").toBe(began);
		host.state("a", "idle");
		expect(host.list()[0]?.since).toBe("2026-11-20T20:40:00.000Z");
	} finally {
		vi.useRealTimers();
	}
});

it("closes one owner under its own context while siblings keep their resources", async () => {
	const host = start();
	const seen: unknown[] = [];
	host.register(
		registration("a", (why) => {
			seen.push(why, ambientSession(), sessionEnv().get("MARKER"));
			void host.stamp("a", "closed");
		}),
	);
	host.register(registration("b"));
	const aSlot = host.run("a", () => sessionSlot("slot", undefined, () => ({})));
	const bSlot = host.run("b", () => sessionSlot("slot", undefined, () => ({})));
	const aOwner = await sessionOwner("a");
	if (!aOwner) throw new Error("host owner absent");

	await endSession(aOwner, "finished");

	expect(seen).toEqual(["finished", "a", "a"]);
	expect(host.holds("a")).toBeUndefined();
	expect(host.run("b", () => sessionSlot("slot", undefined, () => ({})))).toBe(
		bSlot,
	);
	host.register(registration("a"));
	expect(
		host.run("a", () => sessionSlot("slot", undefined, () => ({}))),
	).not.toBe(aSlot);
});

it("refuses new admission during shutdown and joins concurrent close calls", async () => {
	const host = start();
	let finish: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const cleanup = vi.fn(() => closed);
	host.register(registration("a", cleanup));
	host.register(registration("b"));

	const first = host.close("a");
	expect(host.close("a")).toBe(first);
	expect(() => host.run("a", () => {})).toThrow("closing");
	expect(() => host.state("a", "busy")).toThrow("closing");
	expect(host.holds("a")).toBe("parked");
	expect(host.run("b", () => "usable")).toBe("usable");
	finish();
	await first;

	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(registry(host).sessions).toMatchObject([{ id: "b" }]);
});

it("retains a parked owner after failed cleanup and lets close retry", async () => {
	const host = start();
	const cleanup = vi
		.fn()
		.mockRejectedValueOnce(new Error("cleanup failed"))
		.mockResolvedValue(undefined);
	host.register(registration("a", cleanup));
	host.register(registration("b"));

	await expect(host.close("a")).rejects.toThrow("cleanup failed");
	expect(host.holds("a")).toBe("parked");
	expect(registry(host).sessions).toHaveLength(2);
	expect(() => host.run("a", () => {})).toThrow("closing");
	await host.close("a");

	expect(host.holds("a")).toBeUndefined();
	expect(host.holds("b")).toBe("idle");
});

// #2164 F4, F16: a close after a stop whose cleanup failed must end it
// closed, its calls ended, rather than keep the stop's ending.
it("stamps closed and leaves closed when a close follows a stop whose cleanup failed", async () => {
	const left: string[] = [];
	const host = start({
		changed: () => {},
		left: (ending) => {
			left.push(ending);
		},
	});
	const stamped: string[] = [];
	const cleanup = vi
		.fn()
		.mockRejectedValueOnce(new Error("cleanup failed"))
		.mockResolvedValue(undefined);
	host.register({
		...registration("a", cleanup),
		stamp: (how) => {
			stamped.push(how);
		},
	});
	host.register(registration("b"));

	await expect(host.stop("a")).rejects.toThrow("cleanup failed");
	await host.close("a");

	expect(stamped).toEqual(["signalled", "closed"]);
	expect(left).toEqual(["closed"]);
});

it("rolls back opens and state changes when atomic publication fails", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	const before = registry(host);
	const unblock = blockPublication(host);

	expect(() => host.register(registration("c"))).toThrow();
	expect(() => host.state("a", "busy")).toThrow();

	expect(host.holds("c")).toBeUndefined();
	expect(host.holds("a")).toBe("idle");
	unblock();
	expect(registry(host)).toEqual(before);
});

it("retries failed close publication without repeating successful cleanup", async () => {
	const host = start();
	let unblock = () => {};
	const cleanup = vi.fn(() => {
		unblock = blockPublication(host);
	});
	host.register(registration("a", cleanup));
	host.register(registration("b"));

	await expect(host.close("a")).rejects.toThrow();
	expect(host.holds("a")).toBe("parked");
	unblock();
	await host.close("a");

	expect(cleanup).toHaveBeenCalledTimes(1);
	expect(host.holds("a")).toBeUndefined();
	expect(host.holds("b")).toBe("idle");
});

it("refuses duplicate ids and files, relative paths and missing dispatch targets", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));

	expect(() => host.register(registration("a"))).toThrow("already held");
	expect(() =>
		host.register({ ...registration("c"), file: "/sessions/a.jsonl" }),
	).toThrow("file already held");
	expect(() =>
		host.register({
			...registration("c"),
			file: "/sessions/../sessions/a.jsonl",
		}),
	).toThrow("file already held");
	expect(() =>
		host.register({ ...registration("c"), cwd: "relative" }),
	).toThrow("absolute");
	expect(() => host.run("missing", () => {})).toThrow("not held");
});

it("refuses host disposal while a sibling is held and allows empty disposal twice", async () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	await host.close("a");

	expect(() => host.dispose()).toThrow("Close hosted conversations");
	await host.close("b");
	host.dispose();
	host.dispose();

	expect(hosted()).toBeUndefined();
	expect(
		fs.existsSync(host.registryPath),
		"the registry is removed after every conversation closes and the host is disposed",
	).toBe(false);
	expect(() => host.register(registration("a"))).toThrow("disposed");
});

it("routes close and host-stop stamps through each conversation bus", async () => {
	const host = start();
	const seen: unknown[] = [];
	for (const id of ["a", "b"])
		host.register({
			...registration(id),
			stamp: (how) => {
				seen.push([ambientSession(), how]);
			},
		});

	await host.stop("a");
	expect(host.run("b", () => ambientSession())).toBe("b");
	await host.close("b");

	expect(seen).toEqual([
		["a", "signalled"],
		["b", "closed"],
	]);
});

it("tells a conversation the host restarts before stamping it signalled, only for a restart", async () => {
	const host = start();
	const seen: unknown[] = [];
	for (const id of ["a", "b"])
		host.register({
			...registration(id),
			restarting: () => {
				seen.push([ambientSession(), "restarting"]);
			},
			stamp: (how) => {
				seen.push([ambientSession(), how]);
			},
		});

	await host.stop("a", "host restarting", true);
	await host.stop("b");

	expect(seen).toEqual([
		["a", "restarting"],
		["a", "signalled"],
		["b", "signalled"],
	]);
});

// A park carries its conversation's bash calls only by its stop telling
// the conversation the host restarts, as job-workflow then carries (#1981).
it("says a park carries its bash calls as the engine says, and tells the conversation of a restart as a carrying park stops it", async () => {
	const host = start();
	expect(host.carries("a"), "none until the engine says").toBe(false);
	let keeps = true;
	host.keepsCarried(() => keeps);
	expect(host.carries("a"), "the park carries its bash calls").toBe(true);
	keeps = false;
	expect(host.carries("a"), "asked each time").toBe(false);

	const seen: string[] = [];
	host.register({
		...registration("a"),
		restarting: () => {
			seen.push("restarting");
		},
	});
	await host.stop("a", "parked while idle", true);
	expect(seen).toEqual(["restarting"]);
});

// 16 November: a restart found no moment with none of 17 conversations
// running, so a drain parks them; one the person wakes stays awake.
it("drains every conversation but one woken from a park since, until the drain lifts", () => {
	const host = start();
	host.register(registration("a"));
	host.register(registration("b"));
	expect({ drains: host.drains(), a: host.draining("a") }, "undrained").toEqual(
		{ drains: false, a: false },
	);

	host.drain(true);
	host.state("b", "parked");
	host.state("b", "idle");

	expect({
		drains: host.drains(),
		a: host.draining("a"),
		b: host.draining("b"),
	}).toEqual({ drains: true, a: true, b: false });
	host.drain(false);
	host.drain(true);
	expect(
		host.draining("b"),
		"a new drain drains it again, as nothing woke it during this one",
	).toBe(true);
	host.drain(false);
	expect(host.draining("a"), "lifted").toBe(false);
});

// 22 November: 15 children ran host code 34 hours old, since a child
// never restarts. Once its install's host code moves on, its conversation
// parks at its next quiet moment, so its next wake starts a fresh child;
// one a window views stays, as its person may be reading it.
it("rolls each conversation no window views once its host code is stale", () => {
	const dir = mkdtempSync(join(tmpdir(), "session-engine-"));
	directories.push(dir);
	const viewed = new Set(["b"]);
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir: dir,
		viewed: (id) => viewed.has(id),
	});
	hosts.push(host);
	host.register(registration("a"));
	host.register(registration("b"));
	expect({ a: host.rolling("a"), b: host.rolling("b") }, "current").toEqual({
		a: false,
		b: false,
	});

	host.roll();

	expect({ a: host.rolling("a"), b: host.rolling("b") }).toEqual({
		a: true,
		b: false,
	});
	viewed.clear();
	expect(host.rolling("b"), "its window closed").toBe(true);
	expect(
		{ drains: host.drains(), a: host.draining("a") },
		"a roll is no drain",
	).toEqual({ drains: false, a: false });
	expect(hosted()?.rolling?.("a"), "as the park watch asks").toBe(true);
});

// 23 November: a run that steps off as its child rolls writes its wake as
// it parks; woken in the stale child, it would run the old code again.
// A window keeps a stale child running, so one it views wakes there.
it("holds the wakes of those it parked while it drains, and once its code is stale of each no window views", () => {
	const dir = mkdtempSync(join(tmpdir(), "engine-holds-"));
	directories.push(dir);
	const viewed = new Set(["b"]);
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir: dir,
		viewed: (id) => viewed.has(id),
	});
	hosts.push(host);
	const holds = () => ({ a: host.holdsWakes("a"), b: host.holdsWakes("b") });
	expect(holds(), "current and undrained").toEqual({ a: false, b: false });
	host.drain(true);
	expect(holds(), "draining, viewed or not").toEqual({ a: true, b: true });
	host.drain(false);
	expect(holds(), "the drain lifted").toEqual({ a: false, b: false });
	host.roll();
	expect(holds(), "stale, the viewed one woken here").toEqual({
		a: true,
		b: false,
	});
	expect(host.wakeHeld("a"), "as it holds, until told otherwise").toBe(true);
	host.holdsWakesAs(() => false);
	expect(host.wakeHeld("a"), "as its parking says").toBe(false);
	expect(hosted()?.wakeHeld?.("a"), "as the park watch asks").toBe(false);
});

it("uninstalls a failed initial publication so another host can start", () => {
	const dir = mkdtempSync(join(tmpdir(), "engine-failed-"));
	directories.push(dir);
	const file = join(dir, "not-directory");
	fs.writeFileSync(file, "occupied");

	expect(
		() => new SessionHost({ key: "broken", owner, registryDir: file }),
	).toThrow();
	expect(hosted()).toBeUndefined();
	expect(start().list()).toEqual([]);
});
