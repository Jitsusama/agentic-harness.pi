/**
 * The first prompt's wiring: which of a session's ends clear the quest
 * its first prompt made, read from what pi and the bus say as it ends,
 * and a quest that can't be made said in a line rather than thrown.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStartup } from "../../../../extensions/quest-workflow/lifecycle.ts";
import { forageQuest } from "../../../../extensions/quest-workflow/sessions/first-prompt.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { create } from "../../../../extensions/quest-workflow/verbs/lifecycle.ts";
import { sealLoadedQuest } from "../../../../extensions/quest-workflow/verbs/seal.ts";
import {
	type FirstPromptDeps,
	followFirstPrompt,
} from "../../../../extensions/quest-workflow/wiring/first-prompt.ts";
import { installHost } from "../../../../lib/core/session/host.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import {
	PARKING,
	RESTART_ASK,
	type RestartAsk,
} from "../../../../lib/internal/session/park.ts";
import { type FakePi, fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

const WORDS = "Find out why the nightly backup skipped Tuesday";

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};
const envGuard = createEnvGuard();
const cleanups: (() => void)[] = [];

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "first-prompt-wiring-"));
	for (const key of ["HOME", "XDG_CACHE_HOME", "MYCELIUM_HELD"])
		saved[key] = process.env[key];
	process.env.HOME = tmpRoot;
	process.env.XDG_CACHE_HOME = join(tmpRoot, "cache");
	delete process.env.MYCELIUM_HELD;
});
afterEach(() => {
	for (const end of cleanups.splice(0)) end();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
	clearDiscoveryCache();
});

/** Session `session`'s context, with nothing in its log. */
function ctxOf(session: string, notes: string[] = []) {
	return {
		cwd: tmpRoot,
		hasUI: true,
		ui: { notify: (text: string) => notes.push(text) },
		sessionManager: {
			getSessionId: () => session,
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof resolveStartup>[2];
}

/**
 * Session `session` on a quest its first prompt made and left as made,
 * wired with `deps` over a retire that keeps what it retired.
 */
async function wired(session: string, deps: Partial<FirstPromptDeps> = {}) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const pi = fakePi();
	const ctx = ctxOf(session);
	resolveStartup(state, pi, ctx);
	const id = await forageQuest(state, session, WORDS, (params) =>
		create(state, pi, ctx, params),
	);
	const dir = state.questDir;
	if (!id || !dir) throw new Error(`${session} made no quest`);
	const retired: string[] = [];
	followFirstPrompt(pi, state, {
		make: () => () => Promise.reject(new Error("not asked to make one")),
		retire: (params) => {
			retired.push(id);
			return sealLoadedQuest(state, "retire", params);
		},
		signalled: () => false,
		moving: () => false,
		...deps,
	});
	return { pi, ctx, dir, retired };
}

/** Run every handler `pi` holds for `event`, as pi would. */
async function fire(pi: FakePi, event: string, data: unknown, ctx: unknown) {
	for (const handler of pi.recorded.handlers.get(event) ?? [])
		await handler(data, ctx);
}

/** The quest's status, read from its README. */
function statusOf(dir: string) {
	return parseQuestFrontMatter(readFileSync(join(dir, "README.md"), "utf8"))
		?.frontMatter?.status;
}

describe("a first prompt's quest at its session's end", () => {
	it("is retired on a quit its person made", async () => {
		const { pi, ctx, dir, retired } = await wired("sess-quit");
		await fire(pi, "session_shutdown", { reason: "quit" }, ctx);
		expect(retired.length, "the quit retires it").toBe(1);
		expect(statusOf(dir), "it reads as retired").toBe("retired");
	});

	it("is retired when a restart was asked but not taken", async () => {
		const { pi, ctx, retired } = await wired("sess-declined");
		const ask: RestartAsk = {
			session: "sess-declined",
			sessionFile: join(tmpRoot, "fresh.jsonl"),
		};
		pi.events.emit(RESTART_ASK, ask);
		ask.restarting = false;
		await fire(pi, "session_shutdown", { reason: "quit" }, ctx);
		expect(retired.length, "a refused restart is no restart").toBe(1);
	});

	// Each a case of its own, so one that stops holding doesn't hide the rest.
	const comesBack: [
		string,
		Partial<FirstPromptDeps>,
		(pi: FakePi, session: string) => void,
	][] = [
		[
			"a park",
			{},
			(pi, session) => pi.events.emit(PARKING, { session, addresses: [] }),
		],
		[
			"a rollover's restart",
			{},
			(pi, session) => {
				const ask: RestartAsk = {
					session,
					sessionFile: join(tmpRoot, "fresh.jsonl"),
				};
				pi.events.emit(RESTART_ASK, ask);
				// The park watch answers in place, after the ask was heard.
				ask.restarting = true;
			},
		],
		["a signal", { signalled: () => true }, () => {}],
		["a move to another holder", { moving: () => true }, () => {}],
		[
			"a hosted end",
			{},
			() =>
				cleanups.push(
					installHost({
						kind: "pi-durable",
						key: "first-prompt-host",
						owner: { pid: 1, startedAt: 1, bootId: "b", startTicks: 1 },
						holds: () => "idle",
						env: () => {
							throw new Error("these tests read no host env");
						},
						hints: () => ({}),
						close: () => {},
						stamp: () => {},
					}),
				),
		],
	];
	for (const [n, [what, deps, before]] of comesBack.entries()) {
		it(`stays after ${what}`, async () => {
			const session = `sess-back-${n}`;
			const { pi, ctx, dir, retired } = await wired(session, deps);
			before(pi, session);
			await fire(pi, "session_shutdown", { reason: "quit" }, ctx);
			expect(retired, `${what} retires nothing`).toEqual([]);
			expect(statusOf(dir), `${what}: still active`).toBe("active");
		});
	}
});

describe("a first prompt whose quest can't be made", () => {
	it("is said in a line, and the prompt goes on", async () => {
		process.env.MYCELIUM_HELD = "1";
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const pi = fakePi();
		const notes: string[] = [];
		const ctx = ctxOf("sess-unmade", notes);
		resolveStartup(state, pi, ctx);
		followFirstPrompt(pi, state, {
			make: () => () => Promise.reject(new Error("the disk is full")),
			retire: () => Promise.reject(new Error("nothing to retire")),
			signalled: () => false,
			moving: () => false,
		});
		await expect(
			fire(pi, "input", { source: "interactive", text: WORDS }, ctx),
			"the failure isn't thrown at pi",
		).resolves.toBeUndefined();
		expect(notes, "the person is told, with why").toEqual([
			"No quest was made from this prompt: the disk is full",
		]);
		expect(state.questId ?? undefined, "no quest is loaded").toBeUndefined();
	});
});
