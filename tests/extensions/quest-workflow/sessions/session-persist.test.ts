import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetKeeper } from "../../../../extensions/quest-workflow/budget.ts";
import {
	detachSessionFromLoaded,
	PENDING_RETRY_MS,
	PENDING_TRIES,
	persist,
	prunePhantomSessionsOnLoaded,
	releaseSessionOnShutdown,
	resolveStartup,
	restore,
	retryPendingQuest,
} from "../../../../extensions/quest-workflow/lifecycle.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { watchToolCalls } from "../../../../extensions/quest-workflow/wiring/calls.ts";
import { installHost } from "../../../../lib/core/session/index.ts";
import { tickedOwnerNow } from "../../../../lib/internal/process-ticks.ts";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../lib/quest/index.ts";
import {
	type AppendedEntry,
	type FakePi,
	fakePi,
} from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

let tmpRoot: string;
let pi: FakePi;
let entries: AppendedEntry[];

function fakeCtx(cwd: string, sessionId = "sess-1", persisted = true) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			isPersisted: () => persisted,
			getEntries: () =>
				entries.map((e) => ({
					type: "custom" as const,
					customType: e.customType,
					data: e.data,
				})),
		},
	} as unknown as Parameters<typeof handle>[2];
}

function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-persist-"));
	// One pi for the whole test, so everything the workflow appends
	// lands in the one log the context reads back, as a session's does
	// across a reload.
	pi = fakePi();
	entries = pi.recorded.entries;
	// Point the pi session store (sessionsDir keys off HOME) at an
	// empty tmp home so phantom-prune and liveness tests read a known
	// store rather than the developer's real ~/.pi/agent/sessions.
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
) {
	const r = await handle(state, pi, fakeCtx(tmpRoot), {
		action: "create",
		kind: "quest",
		title,
	});
	if (!r.ok) throw new Error(r.guidance);
	// A session already on a quest stays there when it creates one, so
	// these tests, which create one quest after another, load each.
	const loaded = await handle(state, pi, fakeCtx(tmpRoot), {
		action: "load",
		id: String(r.details?.id),
	});
	expect(loaded).toMatchObject({ ok: true });
	return {
		id: state.questId as string,
		dir: state.questDir as string,
	};
}

describe("session membership reconcile", () => {
	function addActiveSession(readmePath: string, sessionId: string): void {
		const parsed = parseQuestFrontMatter(readFileSync(readmePath, "utf8"));
		if (!parsed) throw new Error("unreadable quest");
		const fm = parsed.frontMatter;
		fm.sessions = [
			...fm.sessions.filter((s) => s.id !== sessionId),
			{ id: sessionId, started: new Date().toISOString(), status: "active" },
		];
		writeFileSync(
			readmePath,
			`${serializeQuestFrontMatter(fm)}\n${parsed.body}`,
		);
	}

	function sessionStatus(dir: string, sessionId: string): string | undefined {
		const parsed = parseQuestFrontMatter(
			readFileSync(join(dir, "README.md"), "utf8"),
		);
		return parsed?.frontMatter.sessions.find((s) => s.id === sessionId)?.status;
	}

	it("detaches a straggler quest when the session loads another", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		// Inject a straggler: sess-1 active on Alpha again, the shape a
		// lost state or an earlier run would leave behind.
		addActiveSession(join(a.dir, "README.md"), "sess-1");
		expect(sessionStatus(a.dir, "sess-1")).toBe("active");

		const result = await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		expect(result).toMatchObject({ ok: true });
		// The straggler on Alpha is detached; Bravo keeps it active.
		expect(sessionStatus(a.dir, "sess-1")).toBe("detached");
		expect(sessionStatus(b.dir, "sess-1")).toBe("active");
	});

	it("detaches every straggler, not just the first", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		const c = await createQuest(state, "Charlie");
		// Two stragglers: sess-1 left active on both Alpha and Bravo. A
		// reconcile that broke after the first would leave Bravo active.
		addActiveSession(join(a.dir, "README.md"), "sess-1");
		addActiveSession(join(b.dir, "README.md"), "sess-1");

		const result = await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: c.id,
		});
		expect(result).toMatchObject({ ok: true });
		expect(sessionStatus(a.dir, "sess-1")).toBe("detached");
		expect(sessionStatus(b.dir, "sess-1")).toBe("detached");
		expect(sessionStatus(c.dir, "sess-1")).toBe("active");
	});
});

describe("persist + restore", () => {
	it("persists the loaded quest and restores it on a fresh state", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, pi);

		// Fresh state, same session history. restore picks up
		// the quest that was loaded before the reload.
		const next = buildState();
		const restored = restore(next, pi, fakeCtx(tmpRoot));
		expect(restored, "the loaded quest is restored").toBe(true);
		expect(next.questId).toBe(a.id);
		expect(next.questTitle).toBe("Alpha");
	});

	it("returns false when nothing is persisted", () => {
		const state = buildState();
		const restored = restore(state, pi, fakeCtx(tmpRoot));
		expect(restored, "with nothing persisted there is nothing to restore").toBe(
			false,
		);
		expect(state.questId).toBeNull();
	});

	it("restores the focused document alongside the quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "think",
			kind: "plan",
			note: "investigate",
		});
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "draft",
			title: "Doc One",
		});
		expect(state.documentPath).not.toBeNull();
		persist(state, pi);

		const next = buildState();
		const restored = restore(next, pi, fakeCtx(tmpRoot));
		expect(restored, "the quest and its focused document are restored").toBe(
			true,
		);
		expect(next.questId).toBe(a.id);
		expect(next.documentPath).toBe(state.documentPath);
		expect(next.documentId).toBe(state.documentId);
	});

	it("only the most recent entry hydrates state", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Beta");

		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, pi);
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		persist(state, pi);

		const next = buildState();
		const restored = restore(next, pi, fakeCtx(tmpRoot));
		expect(restored, "the most recent entry is restored").toBe(true);
		expect(next.questId).toBe(b.id);
	});

	it("skips appending when the snapshot equals the most recent entry", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});

		const questEntriesBefore = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;

		// One persist with ctx commits the first snapshot.
		// Four back-to-back persists with no state change
		// dedup against it.
		persist(state, pi, fakeCtx(tmpRoot));
		const afterFirst = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(afterFirst - questEntriesBefore).toBe(1);

		for (let i = 0; i < 4; i++) persist(state, pi, fakeCtx(tmpRoot));
		const afterRepeats = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(afterRepeats).toBe(afterFirst);
	});

	it("appends a new entry after state changes", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, pi, fakeCtx(tmpRoot));
		const before = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;

		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: b.id,
		});
		persist(state, pi, fakeCtx(tmpRoot));
		const after = entries.filter(
			(e) => e.customType === "quest-workflow",
		).length;
		expect(after - before).toBe(1);
	});

	it("refuses to restore a quest that no longer exists on disk", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "load",
			id: a.id,
		});
		persist(state, pi);

		// Wipe the on-disk quest while keeping the session
		// entry pointing at it. Restore should report false
		// instead of half-loading or throwing.
		rmSync(a.dir, { recursive: true, force: true });
		const next = buildState();
		const restored = restore(next, pi, fakeCtx(tmpRoot), false);
		expect(restored, "a quest gone from disk is not restored").toBe(false);
		expect(next.questId).toBeNull();
		expect(
			next.pendingQuest,
			"a walk that caught up holds nothing pending",
		).toBeUndefined();
	});

	// A quest removed for good, read through a walk that was behind,
	// mustn't keep the session from saying anything for good.
	it("lets go of the log's quest once its tries find no such quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		rmSync(a.dir, { recursive: true, force: true });

		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		let now = Date.now();
		for (let tries = 2; tries < PENDING_TRIES; tries++) {
			now += PENDING_RETRY_MS;
			expect(retryPendingQuest(next, pi, now), `try ${tries}`).toBe("waiting");
		}
		expect(next.pendingQuest?.questId, "held to the last try").toBe(a.id);
		now += PENDING_RETRY_MS;
		expect(retryPendingQuest(next, pi, now), "the last try").toBe("gone");
		expect(next.pendingQuest).toBeUndefined();
		persist(next, pi, fakeCtx(tmpRoot));
		const last = entries.at(-1)?.data as
			| { questId?: string | null }
			| undefined;
		expect(last?.questId ?? null, "free to say it holds none").toBeNull();
	});

	// A pi restarted in place keeps the quest its last conversation had;
	// the next persist would write that over this log's word.
	it("puts down a quest this pi had for another conversation while the log's waits", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Beta");
		await handle(state, pi, fakeCtx(tmpRoot), { action: "load", id: a.id });
		persist(state, pi);
		renameSync(a.dir, `${a.dir}.aside`);

		const next = buildState();
		await handle(next, pi, fakeCtx(tmpRoot), { action: "load", id: b.id });
		expect(restore(next, pi, fakeCtx(tmpRoot)), "not found yet").toBe(false);
		expect(next.questId, "the earlier conversation's quest").toBeNull();
		expect(next.pendingQuest?.questId).toBe(a.id);
		persist(next, pi, fakeCtx(tmpRoot));
		const last = entries.at(-1)?.data as { questId?: string } | undefined;
		expect(last?.questId, "the log still names its own").toBe(a.id);
	});

	// What production runs: a tool's result tries again, and a quest that
	// loads is settled on as a start would.
	it("loads the log's quest at a tool's result once it can, and records the session on it", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);
		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot, "sess-late"));
		renameSync(aside, a.dir);

		const budgets: BudgetKeeper = {
			keep: async () => undefined,
			forget: () => undefined,
		};
		watchToolCalls(pi, next, next.questsRoot, budgets);
		const [result] = pi.recorded.handlers.get("tool_result") ?? [];
		if (!result) throw new Error("no tool_result handler");
		const ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() };
		const ctx = { ...fakeCtx(tmpRoot, "sess-late"), hasUI: true, ui };
		const call = {
			toolName: "read",
			input: { path: "x" },
			toolCallId: "c1",
			content: [],
		};
		await result(call, ctx);
		expect(next.questId, "inside its first minute").toBeNull();
		next.pendingRetryAt = 0;
		await result({ ...call, toolCallId: "c2" }, ctx);
		expect(next.questId).toBe(a.id);
		const text = readFileSync(join(a.dir, "README.md"), "utf8");
		const sessions = parseQuestFrontMatter(text)?.frontMatter.sessions ?? [];
		expect(
			sessions.find((s) => s.id === "sess-late")?.status,
			"the session is recorded on it",
		).toBe("active");
		const last = entries.at(-1)?.data as { questId?: string } | undefined;
		expect(last?.questId).toBe(a.id);
		expect(ui.notify, "nothing to warn of").not.toHaveBeenCalled();
	});

	// 20 November: a host restart's signings timed out, the start read a
	// walk without the quest, and the session's next tool wrote
	// questId null over a quest it had held for two days.
	it("keeps the log's quest while it can't load, and loads it once it can", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);

		const next = buildState();
		expect(restore(next, pi, fakeCtx(tmpRoot)), "not found yet").toBe(false);
		const written = entries.length;
		persist(next, pi, fakeCtx(tmpRoot));
		expect(entries.length, "nothing is written over it").toBe(written);
		const last = entries.at(-1)?.data as { questId?: string } | undefined;
		expect(last?.questId).toBe(a.id);

		renameSync(aside, a.dir);
		const later = Date.now() + PENDING_RETRY_MS;
		expect(retryPendingQuest(next, pi, later), "loads once it can").toBe(
			"loaded",
		);
		expect(next.questId).toBe(a.id);
		expect(next.pendingQuest).toBeUndefined();
	});

	it("keeps the log's focused document while its quest can't load, and focuses it once it can", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), { action: "load", id: a.id });
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "draft",
			kind: "plan",
			note: "investigate",
			title: "Doc One",
		});
		expect(state.documentPath).not.toBeNull();
		persist(state, pi);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);

		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		const written = entries.length;
		persist(next, pi, fakeCtx(tmpRoot));
		expect(entries.length, "a pending quest writes nothing").toBe(written);

		renameSync(aside, a.dir);
		expect(
			retryPendingQuest(next, pi, Date.now() + PENDING_RETRY_MS),
			"loads once it can",
		).toBe("loaded");
		expect(next.documentPath).toBe(state.documentPath);
		expect(next.documentId).toBe(state.documentId);
	});

	it("keeps a quest left unfocused on purpose unfocused once it loads", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx(tmpRoot), { action: "load", id: a.id });
		await handle(state, pi, fakeCtx(tmpRoot), {
			action: "draft",
			kind: "plan",
			note: "investigate",
			title: "Doc One",
		});
		await handle(state, pi, fakeCtx(tmpRoot), { action: "unfocus" });
		persist(state, pi);
		const saved = entries.at(-1)?.data as { unfocused?: boolean } | undefined;
		expect(saved?.unfocused, "the log says unfocused").toBe(true);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);

		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		renameSync(aside, a.dir);
		retryPendingQuest(next, pi, Date.now() + PENDING_RETRY_MS);
		expect(next.questId).toBe(a.id);
		expect(next.documentPath).toBeNull();
		persist(next, pi, fakeCtx(tmpRoot));
		const last = entries.at(-1)?.data as { unfocused?: boolean } | undefined;
		expect(last?.unfocused, "still unfocused on purpose").toBe(true);
	});

	it("lets go of a quest still waiting to load once the session loads another", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Beta");
		await handle(state, pi, fakeCtx(tmpRoot), { action: "load", id: a.id });
		persist(state, pi);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);

		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		await handle(next, pi, fakeCtx(tmpRoot), { action: "load", id: b.id });
		persist(next, pi, fakeCtx(tmpRoot));
		expect(next.pendingQuest, "the log's quest is let go").toBeUndefined();
		renameSync(aside, a.dir);
		expect(
			retryPendingQuest(next, pi, Date.now() + PENDING_RETRY_MS),
			"nothing is tried again",
		).toBe("waiting");
		expect(next.questId).toBe(b.id);
	});

	// A host's try reads the quest's folder again on the thread, and may
	// sign the tree off it, so a session's tools mustn't each ask for one.
	it("tries a quest still waiting to load at most once a minute, never on a persist", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		const aside = `${a.dir}.aside`;
		renameSync(a.dir, aside);
		const next = buildState();
		const started = Date.now();
		restore(next, pi, fakeCtx(tmpRoot));
		renameSync(aside, a.dir);

		persist(next, pi, fakeCtx(tmpRoot));
		expect(next.questId, "a persist tries nothing").toBeNull();
		expect(
			retryPendingQuest(next, pi, started),
			"within a minute of the start's try",
		).toBe("waiting");
		expect(next.questId).toBeNull();
		expect(
			retryPendingQuest(next, pi, Date.now() + PENDING_RETRY_MS),
			"a minute on",
		).toBe("loaded");
		expect(next.questId).toBe(a.id);
	});

	// A pi restarted in place keeps what its last conversation wrote to
	// its own log; a key that matches this log's next write mustn't pass
	// for this log having said it.
	it("says a quest let go in this log, though the pi's earlier conversation said none in its own", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		rmSync(a.dir, { recursive: true, force: true });

		const next = buildState();
		persist(next, fakePi(), fakeCtx(tmpRoot));
		expect(
			next.lastPersistedKey,
			"the earlier conversation said",
		).toBeDefined();
		resolveStartup(next, pi, fakeCtx(tmpRoot), {});
		expect(next.pendingQuest?.questId).toBe(a.id);
		await handle(next, pi, fakeCtx(tmpRoot), { action: "unload" });
		persist(next, pi, fakeCtx(tmpRoot));
		const last = entries.at(-1)?.data as
			| { questId?: string | null }
			| undefined;
		expect(last?.questId ?? null, "this log says it holds none").toBeNull();
	});

	// A quest is held pending mostly on a host, whose conversations are
	// bound with no interface, so only what goes into the log reaches the
	// viewer (and the model).
	it("tells a hosted session's log when the quest it names is let go", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		rmSync(a.dir, { recursive: true, force: true });
		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));

		const owner = await tickedOwnerNow();
		if (!owner) throw new Error("test process has no identity");
		const uninstall = installHost({
			kind: "pi-durable",
			key: "persist-test-host",
			owner,
			holds: () => "busy",
			env: () => {
				throw new Error("no environment needed");
			},
			hints: () => ({}),
			close: () => undefined,
			stamp: vi.fn(),
		});
		try {
			const budgets: BudgetKeeper = {
				keep: async () => undefined,
				forget: () => undefined,
			};
			watchToolCalls(pi, next, next.questsRoot, budgets);
			const [result] = pi.recorded.handlers.get("tool_result") ?? [];
			if (!result) throw new Error("no tool_result handler");
			const ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() };
			const ctx = { ...fakeCtx(tmpRoot), hasUI: false, ui };
			for (let tries = 1; tries < PENDING_TRIES; tries++) {
				next.pendingRetryAt = 0;
				await result(
					{
						toolName: "read",
						input: { path: "x" },
						toolCallId: `c${tries}`,
						content: [],
					},
					ctx,
				);
			}
			expect(next.pendingQuest, "let go").toBeUndefined();
			const said = pi.recorded.sent.filter((m) =>
				String(m.content).includes("never found again"),
			);
			expect(said, "said once, in the log").toHaveLength(1);
			expect(said[0]?.display, "the viewer shows it").toBe(true);
			expect(ui.notify, "no interface to tell").not.toHaveBeenCalled();
		} finally {
			uninstall();
		}
	});

	it("warns a session with a screen when the quest its log names is let go", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		rmSync(a.dir, { recursive: true, force: true });
		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		const budgets: BudgetKeeper = {
			keep: async () => undefined,
			forget: () => undefined,
		};
		watchToolCalls(pi, next, next.questsRoot, budgets);
		const [result] = pi.recorded.handlers.get("tool_result") ?? [];
		if (!result) throw new Error("no tool_result handler");
		const ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() };
		const ctx = { ...fakeCtx(tmpRoot), hasUI: true, ui };
		for (let tries = 1; tries < PENDING_TRIES; tries++) {
			next.pendingRetryAt = 0;
			await result(
				{
					toolName: "read",
					input: { path: "x" },
					toolCallId: `c${tries}`,
					content: [],
				},
				ctx,
			);
		}
		expect(next.pendingQuest, "let go").toBeUndefined();
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("never found again"),
			"warning",
		);
		const said = pi.recorded.sent.filter((m) =>
			String(m.content).includes("never found again"),
		);
		expect(said, "the screen says it, not the log").toHaveLength(0);
	});

	it("lets go of a quest still waiting to load when the session unloads", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		persist(state, pi);
		rmSync(a.dir, { recursive: true, force: true });

		const next = buildState();
		restore(next, pi, fakeCtx(tmpRoot));
		const unloaded = await handle(next, pi, fakeCtx(tmpRoot), {
			action: "unload",
		});
		expect(unloaded).toMatchObject({ ok: true });
		if (!unloaded.ok) throw new Error("expected the unload to go through");
		expect(unloaded.message, "says what it let go").toContain(a.id);
		expect(next.pendingQuest).toBeUndefined();
		expect(next.pendingRetryAt).toBeUndefined();
		expect(next.pendingTries).toBeUndefined();
		persist(next, pi, fakeCtx(tmpRoot));
		const last = entries.at(-1)?.data as
			| { questId?: string | null }
			| undefined;
		expect(last?.questId ?? null).toBeNull();
	});
});

describe("persisted cwd", () => {
	it("records the session cwd in the snapshot", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/here"), {
			action: "load",
			id: a.id,
		});
		persist(state, pi, fakeCtx("/work/here"));
		const last = entries
			.filter((e) => e.customType === "quest-workflow")
			.at(-1);
		expect((last?.data as { cwd?: string })?.cwd).toBe("/work/here");
	});
});

describe("auto-attach on load", () => {
	function sessionsOf(dir: string) {
		const text = readFileSync(join(dir, "README.md"), "utf8");
		const parsed = parseQuestFrontMatter(text);
		return parsed?.frontMatter.sessions ?? [];
	}

	it("attaches the current session to the loaded quest's frontmatter", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const sessions = sessionsOf(a.dir);
		const mine = sessions.find((s) => s.id === "sess-load");
		expect(mine).toBeDefined();
		expect(mine?.status).toBe("active");
		expect(mine?.cwd).toBe("/work/dir");
	});

	it("does not attach an ephemeral (--no-session) session", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-ephemeral", false), {
			action: "load",
			id: a.id,
		});
		expect(sessionsOf(a.dir)).not.toContainEqual(
			expect.objectContaining({ id: "sess-ephemeral" }),
		);
	});

	it("keeps the session active when the same quest is reloaded (no switch-detach)", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "stay"), {
			action: "load",
			id: a.id,
		});
		await handle(state, pi, fakeCtx("/work/dir", "stay"), {
			action: "load",
			id: a.id,
		});
		expect(sessionsOf(a.dir).find((s) => s.id === "stay")?.status).toBe(
			"active",
		);
	});

	it("does not duplicate the session when the same quest is reloaded", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		await handle(state, pi, fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const mine = sessionsOf(a.dir).filter((s) => s.id === "sess-load");
		expect(mine).toHaveLength(1);
	});

	it("does not rewrite the quest when there is no phantom to prune", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		// Pre-age `updated` so a stray rewrite is detectable: a no-op
		// prune must not bump it back to today.
		const readme = join(a.dir, "README.md");
		writeFileSync(
			readme,
			readFileSync(readme, "utf8").replace(
				/updated: .*/,
				"updated: 2020-01-01",
			),
		);
		const { removed } = prunePhantomSessionsOnLoaded(state);
		expect(removed).toBe(0);
		expect(readFileSync(readme, "utf8")).toContain("updated: 2020-01-01");
	});

	it("prunes a detached no-log phantom when the quest is next loaded", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "phantom"), {
			action: "load",
			id: a.id,
		});
		// The session has no log on disk (test ctx), so once detached it
		// is a phantom. Loading again under a different session id must
		// garbage-collect it rather than carry it forever.
		detachSessionFromLoaded(state, "phantom");
		expect(sessionsOf(a.dir)).toContainEqual(
			expect.objectContaining({ id: "phantom" }),
		);
		await handle(state, pi, fakeCtx("/work/dir", "fresh"), {
			action: "load",
			id: a.id,
		});
		const ids = sessionsOf(a.dir).map((s) => s.id);
		expect(ids).not.toContain("phantom");
		expect(ids).toContain("fresh");
	});

	it("detaches the session from the quest it leaves on a switch", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Beta");
		// One session loads Alpha, then switches to Beta.
		await handle(state, pi, fakeCtx("/work/dir", "roamer"), {
			action: "load",
			id: a.id,
		});
		await handle(state, pi, fakeCtx("/work/dir", "roamer"), {
			action: "load",
			id: b.id,
		});
		// Alpha must no longer show the session as active; Beta does.
		expect(sessionsOf(a.dir).find((s) => s.id === "roamer")?.status).toBe(
			"detached",
		);
		expect(sessionsOf(b.dir).find((s) => s.id === "roamer")?.status).toBe(
			"active",
		);
	});

	it("detaches the session this process attached when it shuts down", async () => {
		// The lease compares the instance id stored at attach with this
		// process's own. Attach and shutdown once read that id from two
		// copies of the module, each minting its own, so every shutdown
		// thought another process owned the session and every README
		// kept its tabs active for ever.
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-x"), {
			action: "load",
			id: a.id,
		});
		expect(sessionsOf(a.dir).find((s) => s.id === "sess-x")?.status).toBe(
			"active",
		);

		releaseSessionOnShutdown(state, "sess-x");
		expect(sessionsOf(a.dir).find((s) => s.id === "sess-x")?.status).toBe(
			"detached",
		);
	});

	it("leaves a session another process has since taken over", async () => {
		// A resumed session reattaches under the new process's id. The
		// old process shutting down late must not release it.
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-x"), {
			action: "load",
			id: a.id,
		});
		const readme = join(a.dir, "README.md");
		const parsed = parseQuestFrontMatter(readFileSync(readme, "utf8"));
		if (!parsed) throw new Error("unreadable quest");
		parsed.frontMatter.sessions = parsed.frontMatter.sessions.map((s) =>
			s.id === "sess-x" ? { ...s, instanceId: "another-process" } : s,
		);
		writeFileSync(
			readme,
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);

		releaseSessionOnShutdown(state, "sess-x");
		expect(sessionsOf(a.dir).find((s) => s.id === "sess-x")?.status).toBe(
			"active",
		);
	});

	it("preserves the original started timestamp across reloads", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, pi, fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const firstStarted = sessionsOf(a.dir).find(
			(s) => s.id === "sess-load",
		)?.started;
		expect(firstStarted).toBeDefined();

		// A later load of the same session must not re-stamp started to
		// the latest attach time.
		await handle(state, pi, fakeCtx("/work/dir", "sess-load"), {
			action: "load",
			id: a.id,
		});
		const secondStarted = sessionsOf(a.dir).find(
			(s) => s.id === "sess-load",
		)?.started;
		expect(secondStarted).toBe(firstStarted);
	});
});
