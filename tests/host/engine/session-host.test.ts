/** Two hosted conversations share a process, never state or lifecycle. */
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ConversationRegistration,
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

function start() {
	const dir = mkdtempSync(join(tmpdir(), "session-engine-"));
	directories.push(dir);
	const host = new SessionHost({ key: "test-host", owner, registryDir: dir });
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
