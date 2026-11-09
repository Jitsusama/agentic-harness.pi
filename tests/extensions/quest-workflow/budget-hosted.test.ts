/** Budgets and commit credit stay with a conversation in a shared host. */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import attributionExtension from "../../../extensions/attribution-interceptor/index.ts";
import { keepQuestBudget } from "../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import {
	processOverlay,
	withoutBudget,
} from "../../../lib/budget/environment.ts";
import {
	type BudgetAnswer,
	registerBudgetProvider,
} from "../../../lib/budget/provider.ts";
import {
	installHost,
	releaseSession,
	type SessionEnvironment,
	sessionEnv,
	withSession,
} from "../../../lib/core/session/index.ts";
import { coAuthorTrailer } from "../../../lib/internal/guardian/commit-trailer.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

let root: string;
let uninstall: () => void;
const repos: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-budgets-"));
	const environments = new Map<string, SessionEnvironment>();
	uninstall = installHost({
		kind: "pi-durable",
		key: "test-budgets",
		owner: { pid: process.pid, startedAt: 1 },
		holds: () => "idle",
		env: (id) => {
			let env = environments.get(id);
			if (!env) {
				const values: NodeJS.ProcessEnv = {
					HOME: root,
					XDG_RUNTIME_DIR: root,
					TMPDIR: root,
					PATH: process.env.PATH,
					MODEL_KEY: `personal-${id}`,
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
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
});

afterEach(() => {
	releaseSession("a");
	releaseSession("b");
	uninstall();
	for (const repo of repos.splice(0)) disposeRepo(repo);
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function conversation(id: string) {
	const pi = fakePi();
	const ctx = {
		cwd: root,
		sessionManager: {
			getSessionId: () => id,
			getBranch: () =>
				pi.recorded.entries.map((entry) => ({ type: "custom", ...entry })),
		},
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	const quest = `QEST-20261109-00000${id.toUpperCase()}`;
	mkdirSync(join(root, quest));
	writeFileSync(
		join(root, quest, "README.md"),
		`---\nid: ${quest}\nkind: quest\nstatus: active\npriority: active\nrank: 1\nparent: null\nstarted: 2026-11-09\nupdated: 2026-11-09\nbudget: team-${id}\n---\n# Test\n`,
	);
	const state = createQuestState({ questsRoot: root });
	state.questId = quest;
	const keeper = keepQuestBudget(pi, state);
	return { pi, ctx, state, keeper };
}

it("settles interleaved budgets explicitly, preserves overlays on reload and lifts only its own", async () => {
	vi.stubEnv("PI_BUDGET", "host-budget");
	vi.stubEnv("MODEL_KEY", "host-key");
	const a = conversation("a");
	const b = conversation("b");
	let resolveA: (answer: BudgetAnswer) => void = () => {};
	registerBudgetProvider(a.pi.events, {
		id: "test",
		precedence: 0,
		resolve: () =>
			new Promise((resolve) => {
				resolveA = resolve;
			}),
	});
	registerBudgetProvider(b.pi.events, {
		id: "test",
		precedence: 0,
		resolve: async () => ({
			kind: "drawn",
			label: "B",
			env: { MODEL_KEY: "key-b" },
		}),
	});
	const pending = withSession("a", () => a.keeper.keep(a.ctx));
	await withSession("b", () => b.keeper.keep(b.ctx));
	withSession("b", () =>
		resolveA({ kind: "drawn", label: "A", env: { MODEL_KEY: "key-a" } }),
	);
	await pending;
	for (const [id, side] of [
		["a", a],
		["b", b],
	] as const) {
		const env = sessionEnv(side.ctx).snapshot();
		expect(
			execFileSync("sh", ["-c", 'printf \'%s:%s\' "$PI_BUDGET" "$MODEL_KEY"'], {
				env,
				encoding: "utf8",
			}),
		).toBe(`team-${id}:key-${id}`);
		expect(side.pi.recorded.entries.at(-1)?.data).toMatchObject({
			name: `team-${id}`,
		});
		expect(withoutBudget(env, processOverlay(side.ctx)).MODEL_KEY).toBe(
			`personal-${id}`,
		);
	}
	// A new extension load sees the same overlay, even under B's dispatch.
	a.keeper.forget();
	a.state.questId = null;
	const reloaded = keepQuestBudget(a.pi, a.state);
	await withSession("b", () => reloaded.keep(a.ctx));
	expect(sessionEnv(a.ctx).get("MODEL_KEY")).toBe("personal-a");
	expect(sessionEnv(a.ctx).get("PI_BUDGET")).toBeUndefined();
	expect(sessionEnv(b.ctx).get("MODEL_KEY")).toBe("key-b");
	expect(sessionEnv(b.ctx).get("PI_BUDGET")).toBe("team-b");
	expect(process.env.PI_BUDGET).toBe("host-budget");
	expect(process.env.MODEL_KEY).toBe("host-key");
});

it("keeps each model's trailer for the installed commit hook, not the last bash caller's", async () => {
	vi.stubEnv("PI_CO_AUTHOR", "host-credit");
	const a = conversation("a");
	const b = conversation("b");
	const models = ["claude-opus-4-6", "gpt-5.2"];
	for (const [index, side] of [a, b].entries()) {
		const repo = await freshRepo();
		repos.push(repo);
		const ctx = { ...side.ctx, cwd: repo, model: { id: models[index] } };
		attributionExtension(side.pi);
		for (const handler of side.pi.recorded.handlers.get("session_start") ?? [])
			await handler({}, ctx);
		for (const handler of side.pi.recorded.handlers.get("tool_call") ?? []) {
			await handler(
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "test",
					input: { command: "git status" },
				},
				ctx,
			);
		}
	}
	// Invoke A's hook after B's bash call, just as an asynchronous git child does.
	for (const [index, side] of [a, b].entries()) {
		const repo = repos[index];
		const message = join(repo, "message");
		writeFileSync(message, "fix: test\n");
		execFileSync("sh", [join(repo, ".git/hooks/prepare-commit-msg"), message], {
			env: sessionEnv(side.ctx).snapshot(),
		});
		const text = readFileSync(message, "utf8");
		expect(text).toContain(coAuthorTrailer(models[index]));
		expect(text).not.toContain(coAuthorTrailer(models[1 - index]));
	}
	expect(process.env.PI_CO_AUTHOR).toBe("host-credit");
});
