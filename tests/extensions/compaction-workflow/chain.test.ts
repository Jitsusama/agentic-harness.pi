/**
 * The host walks its chain of providers: the first that can write the
 * summary does, every one passed over is recorded, and providers
 * arrive over the bus whatever order things load in.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AHEAD_UNUSED_ENTRY,
	registerCompactionHost,
	SUMMARY_FALLBACK_ENTRY,
} from "../../../extensions/compaction-workflow/host.ts";
import {
	COMPACTION_READY,
	COMPACTION_REQUEST,
	type CompactionAssessment,
	type CompactionHostApi,
	type CompactionProvider,
	type CompactionRequest,
	type CompactionWritten,
	registerCompactionProvider,
	SUMMARY_CONTRIBUTIONS,
	type SummaryContributions,
} from "../../../lib/compaction/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function piFake() {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<[string, unknown]> = [];
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const events = {
		on: (channel: string, h: (data: unknown) => void) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), h]);
			return () => {};
		},
		emit: (channel: string, data: unknown) => {
			for (const h of listeners.get(channel) ?? []) h(data);
		},
	};
	const pi = {
		events,
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry: (type: string, data: unknown) => entries.push([type, data]),
	};
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		let result: unknown;
		for (const h of handlers.get(name) ?? []) result = await h(event, ctx);
		return result;
	};
	return {
		api: pi as unknown as ExtensionAPI,
		events,
		entries,
		fire,
		handlers,
	};
}

interface Fake extends CompactionProvider {
	readonly writes: CompactionRequest[];
}

function fake(
	id: string,
	options: {
		precedence?: number;
		followsFocus?: boolean;
		assess?: CompactionAssessment;
		write?: CompactionWritten;
	} = {},
): Fake {
	const writes: CompactionRequest[] = [];
	return {
		id,
		precedence: options.precedence ?? 100,
		followsFocus: options.followsFocus ?? true,
		writes,
		assess: () => options.assess ?? { ok: true, dollars: 1 },
		write: async (request) => {
			writes.push(request);
			return options.write ?? { ok: true, text: `by ${id}` };
		},
	};
}

function activate(
	providers: CompactionProvider[],
	before?: (f: ReturnType<typeof piFake>) => void,
) {
	const f = piFake();
	before?.(f);
	const host = registerCompactionHost(f.api, {
		providers,
		expectedOutputTokens: () => 7_700,
	});
	return { ...f, host };
}

const branch = [
	{ type: "message", id: "u1", message: { role: "user", content: [] } },
	{ type: "message", id: "a1", message: { role: "assistant", content: [] } },
];

function context(entries: unknown[] = branch, leaf: string | null = "a1") {
	return {
		hasUI: false,
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => entries,
			getSessionId: () => "s1",
		},
	} as unknown as ExtensionContext;
}

function compactEvent(customInstructions?: string) {
	return {
		preparation: {
			firstKeptEntryId: "u1",
			tokensBefore: 300_000,
			previousSummary: undefined,
			fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			settings: { reserveTokens: 64_000 },
		},
		customInstructions,
		reason: "threshold",
		signal: new AbortController().signal,
	};
}

type Compacted = {
	compaction: { summary: string; details: Record<string, unknown> };
};

async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("walking the provider chain on the spot", () => {
	it("records a decline and a failed write, and lets the next provider write", async () => {
		const declines = fake("first", {
			precedence: 1,
			assess: { ok: false, reason: "not today" },
		});
		const fails = fake("second", {
			precedence: 2,
			write: { ok: false, reason: "it broke" },
		});
		const writes = fake("third", {
			precedence: 3,
			write: { ok: true, text: "done", details: { units: 4 } },
		});
		const { fire } = activate([writes, fails, declines]);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.summary).toBe("done");
		expect(result.compaction.details).toMatchObject({
			summariser: "third",
			written: "on the spot",
			provider: { units: 4 },
			attempts: [
				{
					provider: "first",
					timing: "on the spot",
					outcome: "declined",
					reason: "not today",
				},
				{
					provider: "second",
					timing: "on the spot",
					outcome: "failed",
					reason: "it broke",
				},
			],
		});
		expect(declines.writes).toHaveLength(0);
		expect(fails.writes).toHaveLength(1);
		expect(writes.writes).toHaveLength(1);
	});

	it("runs exactly a configured chain and reports an id nothing registered", async () => {
		vi.stubEnv("PI_COMPACTION_PROVIDERS", "missing,late");
		const early = fake("early", { precedence: 1 });
		const late = fake("late", { precedence: 2 });
		const { fire } = activate([early, late]);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({
			summariser: "late",
			attempts: [
				{
					provider: "missing",
					outcome: "declined",
					reason: "no provider is registered with this id",
				},
			],
		});
		expect(early.writes).toHaveLength(0);
	});

	it("skips a provider that cannot follow a typed focus, and hands the next one that focus", async () => {
		const blind = fake("blind", { precedence: 1, followsFocus: false });
		const sighted = fake("sighted", { precedence: 2 });
		const { fire } = activate([blind, sighted]);

		await fire("session_before_compact", compactEvent("the layer"), context());

		expect(blind.writes).toHaveLength(0);
		expect(sighted.writes[0]?.focus.requested).toBe("the layer");
	});

	it("lets a provider that cannot follow a contributed focus write, and says it did not follow it", async () => {
		const blind = fake("blind", { followsFocus: false });
		const { fire, events } = activate([blind]);
		events.on(SUMMARY_CONTRIBUTIONS, (data) =>
			(data as SummaryContributions).instructions.push("the layer"),
		);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({
			summariser: "blind",
			focusFollowed: false,
		});
	});

	it("appends what contributors add to whichever provider wrote it", async () => {
		const { fire, events } = activate([fake("only")]);
		const seen: SummaryContributions[] = [];
		events.on(SUMMARY_CONTRIBUTIONS, (data) => {
			const c = data as SummaryContributions;
			c.appendix.push("\n\n## Mastery");
			seen.push(c);
		});

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.summary).toBe("by only\n\n## Mastery");
		expect(seen[0]?.handled).toBe(true);
	});

	it("hands the compaction to pi, with every attempt, when no provider writes", async () => {
		const { fire, entries } = activate([
			fake("only", { write: { ok: false, reason: "it broke" } }),
		]);

		const result = await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		);

		expect(result).toBeUndefined();
		expect(entries).toEqual([
			[
				SUMMARY_FALLBACK_ENTRY,
				{
					reason: "it broke",
					attempts: [
						{
							provider: "only",
							timing: "on the spot",
							outcome: "failed",
							reason: "it broke",
						},
					],
				},
			],
		]);
	});

	it("takes a provider that throws as one that declined or failed", async () => {
		const throwing: CompactionProvider = {
			...fake("throwing", { precedence: 1 }),
			assess: () => {
				throw new Error("assess blew up");
			},
		};
		const rejecting: CompactionProvider = {
			...fake("rejecting", { precedence: 2 }),
			write: () => Promise.reject(new Error("write blew up")),
		};
		const { fire } = activate([
			throwing,
			rejecting,
			fake("last", { precedence: 3 }),
		]);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({
			summariser: "last",
			attempts: [
				{ provider: "throwing", outcome: "declined", reason: "assess blew up" },
				{ provider: "rejecting", outcome: "failed", reason: "write blew up" },
			],
		});
	});
});

describe("writing ahead through the chain", () => {
	it("writes ahead with the first provider that can, and asks it once for the compaction", async () => {
		const cannot = fake("cannot", {
			precedence: 1,
			assess: { ok: false, reason: "only on the spot" },
		});
		const can = fake("can", { precedence: 2 });
		const { fire, host } = activate([cannot, can]);

		expect(host.prepare(context(), 300_000)).toEqual({ ok: true });
		await settle();
		expect(host.state()).toBe("ready");
		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({
			summariser: "can",
			written: "ahead",
			attempts: [{ provider: "cannot", timing: "ahead", outcome: "declined" }],
		});
		expect(can.writes).toHaveLength(1);
		expect(can.writes[0]?.timing).toBe("ahead");
	});

	it("refuses to write ahead, with the first reason, when nothing in the chain can", () => {
		const { host } = activate([
			fake("a", {
				precedence: 1,
				assess: { ok: false, reason: "first reason" },
			}),
			fake("b", { precedence: 2, assess: { ok: false, reason: "second" } }),
		]);
		expect(host.prepare(context(), 300_000)).toEqual({
			ok: false,
			reason: "first reason",
		});
	});

	it("discards a summary written ahead when the compaction asks for a focus, and writes one that follows it", async () => {
		const only = fake("only");
		const { fire, host, entries } = activate([only]);
		host.prepare(context(), 300_000);
		await settle();

		const result = (await fire(
			"session_before_compact",
			compactEvent("the layer"),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({ written: "on the spot" });
		expect(only.writes.map((w) => w.focus.requested)).toEqual([
			undefined,
			"the layer",
		]);
		expect(entries).toEqual([
			[
				AHEAD_UNUSED_ENTRY,
				{ reason: "the compaction asked for a focus it was written without" },
			],
		]);
	});

	it("leaves the compaction to the walk on the spot when the summary written ahead failed", async () => {
		let calls = 0;
		const flaky: CompactionProvider = {
			...fake("flaky"),
			write: async () =>
				++calls === 1
					? { ok: false, reason: "not this time" }
					: { ok: true, text: "second time" },
		};
		const { fire, host } = activate([flaky]);
		host.prepare(context(), 300_000);
		await settle();
		expect(host.state()).toBe("failed");

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.summary).toBe("second time");
		expect(result.compaction.details).toMatchObject({
			written: "on the spot",
			attempts: [
				{
					provider: "flaky",
					timing: "ahead",
					outcome: "failed",
					reason: "not this time",
				},
			],
		});
	});
});

describe("pricing from the chain", () => {
	it("prices a summary with the first provider that would write it ahead", () => {
		const { host } = activate([
			fake("dear", { precedence: 2, assess: { ok: true, dollars: 3 } }),
			fake("cheap", { precedence: 1, assess: { ok: true, dollars: 0.2 } }),
		]);
		expect(host.summaryDollars(context(), 300_000)).toBe(0.2);
	});

	it("prices one written on the spot when nothing can write ahead", () => {
		const spotOnly: CompactionProvider = {
			...fake("spot"),
			assess: (request) =>
				request.timing === "ahead"
					? { ok: false, reason: "on the spot only" }
					: { ok: true, dollars: request.contextTokens / 100_000 },
		};
		const { host } = activate([spotOnly]);
		expect(host.summaryDollars(context(), 300_000)).toBe(3);
	});

	it("has no price when no provider would write one", () => {
		const { host } = activate([
			fake("none", { assess: { ok: false, reason: "never" } }),
		]);
		expect(host.summaryDollars(context(), 300_000)).toBeUndefined();
	});
});

describe("registering over the bus", () => {
	it("picks up a provider that registered before the host loaded", async () => {
		const early = fake("early");
		const { fire } = activate([], (f) =>
			registerCompactionProvider(f.events, early),
		);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.details).toMatchObject({ summariser: "early" });
	});

	it("replaces a provider when its id registers again", async () => {
		const first = fake("same", { write: { ok: true, text: "first" } });
		const second = fake("same", { write: { ok: true, text: "second" } });
		const { fire, events } = activate([first]);
		registerCompactionProvider(events, second);

		const result = (await fire(
			"session_before_compact",
			compactEvent(),
			context(),
		)) as Compacted;

		expect(result.compaction.summary).toBe("second");
		expect(first.writes).toHaveLength(0);
	});

	it("announces itself again when asked, listing the chain", () => {
		const { events } = activate([
			fake("b", { precedence: 2 }),
			fake("a", { precedence: 1 }),
		]);
		let announced: CompactionHostApi | undefined;
		events.on(COMPACTION_READY, (data) => {
			announced = data as CompactionHostApi;
		});
		events.emit(COMPACTION_REQUEST, undefined);
		expect(announced?.listProviders()).toEqual(["a", "b"]);
	});

	it("is the one handler of a compaction", () => {
		const { handlers } = activate([fake("only")]);
		expect(handlers.get("session_before_compact")).toHaveLength(1);
	});
});
