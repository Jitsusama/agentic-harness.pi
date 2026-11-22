/** Strict wire boundaries, byte framing and co-hosted control dispatch. */
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
	dispatchControl,
	hostRefusal,
} from "../../../host/service/dispatch.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import {
	parseAdoptResult,
	parseControl,
	parseDrainResult,
	parseListResult,
	parseOpenResult,
	parseReply,
	parseSessionResult,
	parseViewer,
} from "../../../host/service/protocol.ts";
import {
	ambientSession,
	type Host,
	installHost,
	sessionEnv,
} from "../../../lib/core/session/index.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const close = { v: 1, id: "c", op: "close", sessionId: A };
const identity = {
	key: "test",
	owner: { pid: 123, startedAt: 1, startTicks: 20, bootId: "boot" },
};

describe("result validation", () => {
	const held = {
		sessionId: A,
		file: "/sessions/a.jsonl",
		cwd: "/repo",
		state: "idle",
		since: "2026-11-09T15:00:00.000Z",
	};
	it("accepts the agreed result of each operation", () => {
		expect(parseOpenResult(held)).toEqual(held);
		expect(parseAdoptResult({ ...held, state: "busy" }).state).toBe("busy");
		expect(parseListResult({ sessions: [held], host: identity })).toEqual({
			sessions: [held],
			host: identity,
		});
		expect(parseSessionResult({ sessionId: B })).toEqual({ sessionId: B });
		const drained = {
			draining: true,
			busy: 2,
			idle: 0,
			parked: 5,
			heavy: ["job-1 shell: nix-offload there --changed"],
		};
		expect(parseDrainResult(drained)).toEqual(drained);
		expect(
			() => parseDrainResult({ ...drained, busy: -1 }),
			"a count is never negative",
		).toThrow("Invalid host control result");
	});
	it("refuses results a client could act on wrongly", () => {
		for (const bad of [
			{ ...held, id: A },
			{ ...held, sessionId: "durable-conversation" },
			{ ...held, file: "relative.jsonl" },
			{ ...held, state: "closed" },
			{ ...held, since: "yesterday" },
		])
			expect(() => parseOpenResult(bad)).toThrow("Invalid host control result");
		expect(() => parseListResult({ sessions: [held] })).toThrow();
		expect(() => parseSessionResult({ sessionId: A, extra: 1 })).toThrow();
	});
});

describe("the meaning the protocol had in zod, kept", () => {
	const held = {
		sessionId: A,
		file: "/sessions/a.jsonl",
		cwd: "/repo",
		state: "idle",
		since: "2026-11-09T15:00:00.000Z",
	};
	const accepts = (parse: (value: unknown) => unknown, value: unknown) => {
		try {
			parse(value);
			return true;
		} catch {
			return false;
		}
	};

	it("counts a length in UTF-16 units, as zod did, not code points", () => {
		const id = (value: string) =>
			accepts(parseControl, { ...close, id: value });
		expect(id("a".repeat(128))).toBe(true);
		expect(id("a".repeat(129))).toBe(false);
		// 64 code points of two units each fill the 128 exactly.
		expect(id("😀".repeat(64))).toBe(true);
		// 65 code points, which a count of code points would let through.
		expect(id("😀".repeat(65))).toBe(false);
		expect(id("")).toBe(false);
	});

	it("reads a time as an ISO date and time with an offset, leap days included", () => {
		const since = (value: string) =>
			accepts(parseOpenResult, { ...held, since: value });
		for (const value of [
			"2026-11-09T15:00:00Z",
			"2026-11-09T15:00:00.123456Z",
			"2026-11-09T15:00:00+05:30",
			"2026-11-09T15:00Z",
			"2024-02-29T00:00:00Z",
		])
			expect(since(value), value).toBe(true);
		for (const value of [
			"2026-11-09T15:00:00",
			"2026-11-09 15:00:00Z",
			"2023-02-29T00:00:00Z",
			"2026-11-09T24:00:00Z",
			"2026-11-09T15:00:00+5:30",
		])
			expect(since(value), value).toBe(false);
	});

	it("takes a session id in any UUID version zod knew, the nil and max ones too", () => {
		const sessionId = (value: string) =>
			accepts(parseControl, { ...close, sessionId: value });
		for (const value of [
			A,
			"01890a5d-ac96-774b-bcce-b302099a8057",
			"00000000-0000-0000-0000-000000000000",
			"ffffffff-ffff-ffff-ffff-ffffffffffff",
		])
			expect(sessionId(value), value).toBe(true);
		for (const value of [
			"11111111-1111-9111-8111-111111111111",
			"11111111-1111-4111-c111-111111111111",
			"11111111111141118111111111111111",
			`${A}\n`,
		])
			expect(sessionId(value), value).toBe(false);
	});

	it("holds an integer to the safe range and a start time above zero", () => {
		const owner = (change: Record<string, number>) =>
			accepts(parseListResult, {
				sessions: [],
				host: { ...identity, owner: { ...identity.owner, ...change } },
			});
		expect(owner({ pid: Number.MAX_SAFE_INTEGER })).toBe(true);
		expect(owner({ pid: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
		expect(owner({ pid: 0 })).toBe(false);
		expect(owner({ pid: 1.5 })).toBe(false);
		expect(owner({ startedAt: 0.5 })).toBe(true);
		expect(owner({ startedAt: 0 })).toBe(false);
		expect(owner({ startTicks: 0 })).toBe(true);
		expect(owner({ startTicks: -1 })).toBe(false);
	});
});

describe("wire validation", () => {
	it("accepts the agreed operations with one public identity", () => {
		for (const value of [
			{ v: 1, id: "l", op: "list" },
			{
				v: 1,
				id: "o",
				op: "open",
				cwd: "/repo",
				attended: true,
				first: "hello",
			},
			{
				v: 1,
				id: "a",
				op: "adopt",
				sessionFile: "/session.jsonl",
				attended: false,
			},
			// A fenced session's move into a host says how it ran its commands.
			{
				v: 1,
				id: "a",
				op: "adopt",
				sessionFile: "/session.jsonl",
				attended: false,
				env: { PI_SANDBOX: "fence", PI_SPAWNER: "on" },
			},
			{
				v: 1,
				id: "o",
				op: "open",
				cwd: "/repo",
				attended: true,
				env: { PI_SANDBOX: "fence" },
			},
			// The launcher's Orchestrate, started in a host, told nothing.
			{
				v: 1,
				id: "o",
				op: "open",
				cwd: "/repo",
				attended: true,
				quest: "QEST-20261112-ABCDEF",
				orchestrate: true,
			},
			...["release", "close", "abort"].map((op) => ({ ...close, op })),
			// A drain for a restart, and its lift, each naming who asked.
			{ v: 1, id: "d", op: "drain", on: true, by: "integration" },
			{ v: 1, id: "d", op: "drain", on: false },
			{ ...close, op: "attach", rows: 24, columns: 80 },
			// A newer client may say it can do what this host doesn't know yet.
			{
				...close,
				op: "attach",
				rows: 24,
				columns: 80,
				features: ["edit", "suspend", "later"],
			},
		])
			expect(parseControl(value)).toEqual(value);
	});
	it("refuses credentials, duplicate identities, relative paths and unsupported versions", () => {
		for (const value of [
			{ ...close, v: 2 },
			{ ...close, conversation: "durable" },
			{ ...close, sessionId: "short" },
			{ ...close, env: { API_KEY: "secret" } },
			{ ...close, op: "stop" },
			{ ...close, id: "" },
			{ v: 1, id: "a", op: "adopt", sessionFile: "relative", attended: true },
			// Only how a session runs its commands, never a key or a path.
			...[
				{ API_KEY: "secret" },
				{ PI_SANDBOX: "fence", HOME: "/tmp" },
				{ PI_SANDBOX: "fence; rm -rf ~" },
				{},
			].map((env) => ({
				v: 1,
				id: "a",
				op: "adopt",
				sessionFile: "/session.jsonl",
				attended: false,
				env,
			})),
			{ ...close, op: "attach", rows: 0, columns: 80 },
			{ ...close, op: "attach", rows: 24.5, columns: 80 },
			{ ...close, op: "attach", rows: 24, columns: 1001 },
			{ ...close, op: "attach", rows: 24, columns: 80, features: "edit" },
			{
				...close,
				op: "attach",
				rows: 24,
				columns: 80,
				features: Array.from({ length: 17 }, (_, at) => `f${at}`),
			},
		])
			expect(() => parseControl(value)).toThrow("Invalid host");
	});
	it("keeps viewer events distinct from control requests", () => {
		expect(parseViewer({ type: "input", data: "\u001b[A" })).toEqual({
			type: "input",
			data: "\u001b[A",
		});
		expect(parseViewer({ type: "resize", rows: 24, columns: 80 })).toEqual({
			type: "resize",
			rows: 24,
			columns: 80,
		});
		// An edit's answer, and an edit given up on, which keeps the draft.
		for (const value of [
			{ type: "edited", id: "1", text: "new words" },
			{ type: "edited", id: "1" },
		])
			expect(parseViewer(value)).toEqual(value);
		for (const value of [
			close,
			{ type: "input", data: "x", sessionId: B },
			{ type: "resize", rows: -1, columns: 80 },
			{ type: "edited", text: "no id" },
			{ type: "edited", id: "1", text: "x", file: "/tmp/draft" },
		])
			expect(() => parseViewer(value)).toThrow("Invalid host viewer");
	});
});

describe("JSON lines", () => {
	it("reassembles every byte split including UTF-8 and embedded Unicode separators", () => {
		const values = [{ text: "é 🌊 \u2028 \u2029\ntext" }, close];
		const bytes = Buffer.from(
			values.map((v) => `${JSON.stringify(v)}\n`).join(""),
		);
		for (let split = 0; split <= bytes.length; split++) {
			const frames = jsonLines();
			expect([
				...frames.push(bytes.subarray(0, split)),
				...frames.push(bytes.subarray(split)),
			]).toEqual(values);
			frames.end();
		}
	});
	it("bounds a frame rather than a multi-frame chunk", () => {
		expect(jsonLines(2).push(Buffer.from("{}\n{}\n"))).toEqual([{}, {}]);
		const frames = jsonLines(2);
		frames.push(Buffer.from("{"));
		expect(() => frames.push(Buffer.from("  "))).toThrow("byte limit");
		expect(() => frames.push(Buffer.from("}\n"))).toThrow("closed");
	});
	it("fails closed on invalid UTF-8, JSON and partial EOF", () => {
		for (const value of [
			Buffer.from([0xff, 10]),
			Buffer.from("bad\n"),
			Buffer.from("\n"),
		])
			expect(() => jsonLines().push(value)).toThrow("UTF-8 JSON");
		const frames = jsonLines();
		frames.push(Buffer.from("{}"));
		expect(() => frames.end()).toThrow("before LF");
	});
});

describe("co-hosted dispatch", () => {
	it("checks every owner field before dispatch to a replaced socket", async () => {
		const backend = { identity, execute: vi.fn(async () => "ok") };
		for (const changed of [
			{ ...identity, key: "other" },
			{ ...identity, owner: { ...identity.owner, pid: 124 } },
			{ ...identity, owner: { ...identity.owner, startedAt: 2 } },
			{ ...identity, owner: { ...identity.owner, startTicks: 21 } },
			{ ...identity, owner: { ...identity.owner, bootId: "next" } },
			{ ...identity, owner: { pid: 123, startedAt: 1 } },
		])
			expect(
				await dispatchControl({ ...close, expectedHost: changed }, backend),
			).toMatchObject({ id: "c", ok: false, error: { code: "stale_host" } });
		expect(backend.execute).not.toHaveBeenCalled();
		expect(
			await dispatchControl({ ...close, expectedHost: identity }, backend),
		).toMatchObject({ ok: true, result: "ok" });
	});
	it("answers null for a backend that returns nothing, so the reply survives JSON", async () => {
		const backend = { identity, execute: async () => undefined };
		const reply = await dispatchControl(
			{ ...close, expectedHost: identity },
			backend,
		);
		expect(parseReply(JSON.parse(JSON.stringify(reply)))).toEqual({
			v: 1,
			id: "c",
			ok: true,
			result: null,
		});
	});
	it("binds two interleaved requests to their own environment and never signals the host", async () => {
		const held = new Set([A, B]);
		const host: Host = {
			kind: "pi-durable",
			key: "test",
			owner: { pid: 123, startedAt: 1 },
			holds: (id) => (held.has(id) ? "idle" : undefined),
			env: (id) => ({
				get: () => id,
				set: () => {},
				delete: () => {},
				snapshot: () => ({ PI_SESSION_ID: id }),
			}),
			hints: () => ({}),
			close: (id) => {
				held.delete(id);
			},
			stamp: () => {},
		};
		const uninstall = installHost(host);
		const kill = vi.spyOn(process, "kill");
		try {
			const backend = {
				identity,
				execute: async () => {
					await setImmediate();
					const id = ambientSession();
					if (!id) throw new Error("No session");
					expect(sessionEnv().get("PI_SESSION_ID")).toBe(id);
					await host.close(id, "closed");
					return { sessionId: id };
				},
			};
			const replies = await Promise.all(
				[A, B].map((sessionId) =>
					dispatchControl({ ...close, sessionId }, backend),
				),
			);
			expect(replies).toEqual(
				[A, B].map((sessionId) => ({
					v: 1,
					id: "c",
					ok: true,
					result: { sessionId },
				})),
			);
			expect(ambientSession()).toBeUndefined();
			expect(held.size).toBe(0);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			uninstall();
			kill.mockRestore();
		}
	});
	it("never invokes the engine on invalid requests or leaks exception credentials", async () => {
		const backend = {
			identity,
			execute: vi.fn(async () => {
				throw new Error("API_KEY=secret");
			}),
		};
		expect(await dispatchControl({ ...close, env: {} }, backend)).toEqual({
			v: 1,
			id: null,
			ok: false,
			error: {
				code: "invalid_request",
				message: "Invalid host control request",
			},
		});
		expect(backend.execute).not.toHaveBeenCalled();
		const reply = await dispatchControl(close, backend);
		expect(reply).toMatchObject({
			id: "c",
			ok: false,
			error: { code: "operation_failed" },
		});
		expect(JSON.stringify(reply)).not.toContain("secret");
	});
	it("says a refusal written for the requester in its own words, and journals it too", async () => {
		const refused = hostRefusal(
			"rollout_refused",
			"pid 41 runs an old harness",
		);
		const report = vi.fn();
		const backend = {
			identity,
			execute: vi.fn(async () => {
				throw refused;
			}),
		};

		expect(await dispatchControl(close, backend, report)).toEqual({
			v: 1,
			id: "c",
			ok: false,
			error: { code: "rollout_refused", message: "pid 41 runs an old harness" },
		});
		expect(report).toHaveBeenCalledWith(refused);
	});
});
