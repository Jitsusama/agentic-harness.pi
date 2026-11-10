/** Conversation spend stays separate; shared process resources stay with the host. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerBudgetItem } from "../../../extensions/spend-workflow/budget-item.ts";
import spendWorkflow, {
	COST_READING,
} from "../../../extensions/spend-workflow/index.ts";
import {
	earliest,
	forgetLastReading,
	formatUse,
	readSamples,
	recordTurn,
	useByQuest,
} from "../../../extensions/spend-workflow/resources.ts";
import { recordWhoServed } from "../../../extensions/spend-workflow/served.ts";
import {
	recordRunEverywhere,
	runRecordFrom,
} from "../../../lib/core/observability/recorder.ts";
import {
	installHost,
	releaseSession,
	type SessionEnvironment,
	withSession,
} from "../../../lib/core/session/index.ts";
import { SERVED_ENTRY } from "../../../lib/internal/session/served.ts";
import { FOOTER_GLYPH } from "../../../lib/ui/footer-mark.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

let root: string;
let uninstall: () => void;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-spend-"));
	const environments = new Map<string, SessionEnvironment>();
	uninstall = installHost({
		kind: "pi-durable",
		key: "test/spend",
		owner: { pid: process.pid, startedAt: 1 },
		holds: () => "idle",
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
		env: (id) => {
			let env = environments.get(id);
			if (!env) {
				const values: NodeJS.ProcessEnv = {
					HOME: root,
					XDG_RUNTIME_DIR: root,
					TMPDIR: root,
					PI_BUDGET: `budget-${id}`,
				};
				env = {
					get: (key) => values[key],
					set: (key, value) => {
						values[key] = value;
					},
					delete: (key) => {
						delete values[key];
					},
					snapshot: () => ({ ...values }),
				};
				environments.set(id, env);
			}
			return env;
		},
	});
	forgetLastReading();
	vi.stubEnv("XDG_STATE_HOME", root);
});
afterEach(() => {
	for (const id of ["a", "b"]) releaseSession(id);
	uninstall();
	vi.unstubAllEnvs();
	forgetLastReading();
	rmSync(root, { recursive: true, force: true });
});

function context(id: string, statuses: (string | undefined)[] = []) {
	return {
		hasUI: false,
		cwd: root,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `${id}.jsonl`,
			getBranch: () => [],
		},
		ui: {
			theme: { fg: (_colour: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) =>
				statuses.push(text),
		},
	} as unknown as ExtensionContext;
}
async function fire(
	pi: FakePi,
	name: string,
	ctx: ExtensionContext,
	event: unknown = {},
) {
	for (const handler of pi.recorded.handlers.get(name) ?? [])
		await handler(event, ctx);
}

it("uses one host resource baseline across interleaved sessions and module reloads", async () => {
	const read = (cpu: number) => () => ({
		cpuSelfMs: cpu,
		cpuChildrenMs: 0,
		rssBytes: 100,
		readBytes: 0,
		writeBytes: cpu,
	});
	withSession("a", () => recordTurn("a.jsonl", { dir: root, read: read(100) }));
	withSession("b", () => recordTurn("b.jsonl", { dir: root, read: read(150) }));
	vi.resetModules();
	const copy = await import("../../../extensions/spend-workflow/resources.ts");
	withSession("a", () =>
		copy.recordTurn("a.jsonl", { dir: root, read: read(200) }),
	);
	const samples = readSamples(root);
	expect(readdirSync(root)).toEqual([
		`host-test%2Fspend-${process.pid}-1.jsonl`,
	]);
	expect([...samples.values()][0].map((sample) => sample.cpuSelfMs)).toEqual([
		100, 50, 50,
	]);
	const rows = useByQuest(samples, [
		{ session: [...samples.keys()][0], at: "2000-01-01", quest: "QEST-A" },
	]);
	expect(rows).toEqual([
		expect.objectContaining({
			host: "test/spend",
			quest: null,
			cpuSelfMs: 200,
			turns: 3,
		}),
	]);
	const text = formatUse(rows, earliest(samples), 12);
	expect(text).toContain("Host test/spend");
	expect(text).toContain("not per-conversation use");
	expect(text).not.toContain("QEST-A");
});

it("records headless hosted turn hooks in the host log, not either conversation file", async () => {
	const pi = fakePi();
	withSession("a", () => spendWorkflow(pi));
	await fire(pi, "turn_end", context("a"));
	await fire(pi, "turn_end", context("b"));
	const dir = join(
		root,
		"pi",
		"agentic-harness.pi",
		"observability",
		"resources",
	);
	const samples = readSamples(dir);
	expect(samples.size).toBe(1);
	expect([...samples.values()][0]).toHaveLength(2);
	expect([...samples.values()][0].map((sample) => sample.host)).toEqual([
		"test/spend",
		"test/spend",
	]);
});

it("keeps provider history per conversation and retries an entry that failed to append", async () => {
	const pi = fakePi();
	recordWhoServed(pi);
	const a = context("a");
	const b = context("b");
	const response = { headers: { "x-shopify-proxy-provider": "bedrock" } };
	await fire(pi, "after_provider_response", a, response);
	await fire(pi, "after_provider_response", b, response);
	await fire(pi, "after_provider_response", a, response);
	expect(pi.recorded.entries).toHaveLength(2);
	await fire(pi, "session_start", b);
	await fire(pi, "after_provider_response", b, response);
	expect(pi.recorded.entries).toHaveLength(3);
	const append = vi.spyOn(pi, "appendEntry").mockImplementationOnce(() => {
		throw new Error("busy");
	});
	const changed = { headers: { "x-shopify-proxy-provider": "anthropic-dev" } };
	await fire(pi, "after_provider_response", a, changed);
	await fire(pi, "after_provider_response", a, changed);
	expect(append).toHaveBeenCalledTimes(2);
	expect(pi.recorded.entries.at(-1)).toEqual({
		customType: SERVED_ENTRY,
		data: { backend: "anthropic-dev" },
	});
});

it("registers fan-out spend with explicit ctx and disposes only its own sink", async () => {
	const a = fakePi();
	const b = fakePi();
	withSession("a", () => spendWorkflow(a));
	withSession("b", () => spendWorkflow(b));
	// Ambient B must not choose the recorder for A's explicit context.
	await withSession("b", () => fire(a, "session_start", context("a")));
	await withSession("a", () => fire(b, "session_start", context("b")));
	const record = {
		...runRecordFrom({
			runId: "run",
			subagentId: "worker",
			kind: "test",
			model: "test",
			persona: "test",
			thinkingLevel: null,
			startedAt: 1,
			result: { exitCode: 0, sessionIds: [], warnings: [] },
		}),
		cost: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, total: 2 },
	};
	withSession("a", () => recordRunEverywhere(record));
	withSession("b", () =>
		recordRunEverywhere({ ...record, cost: { ...record.cost, total: 5 } }),
	);
	const total = (pi: FakePi) =>
		pi.recorded.emitted
			.filter(([channel]) => channel === COST_READING)
			.at(-1)?.[1];
	expect(total(a)).toMatchObject({ session: 2 });
	expect(total(b)).toMatchObject({ session: 5 });
	await withSession("b", () => fire(a, "session_shutdown", context("a")));
	withSession("a", () => recordRunEverywhere(record));
	withSession("b", () => recordRunEverywhere(record));
	expect(total(a)).toMatchObject({ session: 2 });
	expect(total(b)).toMatchObject({ session: 7 });
	await fire(b, "session_shutdown", context("b"));
});

it("reads each footer's budget from its conversation, even under another ambient session", async () => {
	for (const id of ["a", "b"]) {
		const pi = fakePi();
		const statuses: (string | undefined)[] = [];
		registerBudgetItem(pi, {
			exec: () => async () => ({ code: 127, stdout: "", stderr: "absent" }),
			listPrice: () => 0,
		});
		const ctx = { ...context(id, statuses), hasUI: true };
		await withSession(id === "a" ? "b" : "a", () =>
			fire(pi, "session_start", ctx),
		);
		expect(statuses[0]).toBe(`${FOOTER_GLYPH.budget} budget-${id}`);
		await fire(pi, "session_shutdown", ctx);
	}
});
