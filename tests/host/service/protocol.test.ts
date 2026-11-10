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
			...["release", "close", "abort"].map((op) => ({ ...close, op })),
			{ ...close, op: "attach", rows: 24, columns: 80 },
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
			{ ...close, op: "attach", rows: 0, columns: 80 },
			{ ...close, op: "attach", rows: 24.5, columns: 80 },
			{ ...close, op: "attach", rows: 24, columns: 1001 },
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
		for (const value of [
			close,
			{ type: "input", data: "x", sessionId: B },
			{ type: "resize", rows: -1, columns: 80 },
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
