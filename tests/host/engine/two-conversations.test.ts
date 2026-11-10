/**
 * Two conversations in one shared host keep their budget, commit credit
 * and request attribution apart, even for code that only reads
 * process.env: a commit hook or ai-proxy-headers started with no env of
 * its own.
 */
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
import { afterEach, expect, it, vi } from "vitest";
import attributionExtension from "../../../extensions/attribution-interceptor/index.ts";
import { keepQuestBudget } from "../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { harnessSettings, SessionHost } from "../../../host/engine/index.ts";
import { registerBudgetProvider } from "../../../lib/budget/provider.ts";
import { coAuthorTrailer } from "../../../lib/internal/guardian/commit-trailer.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

const owner = { pid: 321, startedAt: 1000, bootId: "boot", startTicks: 40 };
/** What the host's own launch wrote, which neither conversation shares. */
const HOST_SETTINGS = JSON.stringify({ v: "1", surface: "interactive" });
const MODELS = { a: "claude-opus-4-6", b: "gpt-5.2" } as const;

let host: SessionHost | undefined;
let root: string | undefined;
const repos: string[] = [];
afterEach(async () => {
	if (host) {
		for (const { id } of host.list()) await host.close(id);
		host.dispose();
		host = undefined;
	}
	for (const repo of repos.splice(0)) disposeRepo(repo);
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	vi.unstubAllEnvs();
});

/** A conversation on its own quest, whose budget names its own key. */
async function conversation(
	started: SessionHost,
	id: "a" | "b",
	attended: boolean,
) {
	const base = root ?? "";
	const repo = await freshRepo();
	repos.push(repo);
	started.register({
		id,
		file: join(base, `${id}.jsonl`),
		cwd: repo,
		env: {
			PATH: process.env.PATH,
			HOME: base,
			DEV_INVOCATION_ID: `invocation-${id}`,
			SHOPIFY_HARNESS_SETTINGS: harnessSettings(
				HOST_SETTINGS,
				{ attended },
				{ op: "open" },
				{ version: "9.9.9-engine" },
			),
		},
		hints: {},
		close: () => {},
	});
	const pi = fakePi();
	const ctx = {
		cwd: repo,
		model: { id: MODELS[id] },
		sessionManager: {
			getSessionId: () => id,
			getBranch: () =>
				pi.recorded.entries.map((entry) => ({ type: "custom", ...entry })),
		},
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	const quest = `QEST-20261109-00000${id.toUpperCase()}`;
	mkdirSync(join(base, quest));
	writeFileSync(
		join(base, quest, "README.md"),
		`---\nid: ${quest}\nkind: quest\nstatus: active\npriority: active\nrank: 1\nparent: null\nstarted: 2026-11-09\nupdated: 2026-11-09\nbudget: team-${id}\n---\n# Test\n`,
	);
	registerBudgetProvider(pi.events, {
		id: "test",
		precedence: 0,
		resolve: async (name) => ({
			kind: "drawn",
			label: name,
			env: { MODEL_KEY: `key-${id}` },
		}),
	});
	const state = createQuestState({ questsRoot: base });
	state.questId = quest;
	attributionExtension(pi);
	await started.run(id, async () => {
		await keepQuestBudget(pi, state).keep(ctx);
		for (const handler of pi.recorded.handlers.get("session_start") ?? [])
			await handler({}, ctx);
		for (const handler of pi.recorded.handlers.get("tool_call") ?? [])
			await handler(
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: `bash-${id}`,
					input: { command: "git status" },
				},
				ctx,
			);
	});
	return repo;
}

/** What a child started with no env of its own is handed, as one line. */
function childSees(): string {
	return execFileSync(
		"sh",
		[
			"-c",
			'printf "%s|%s|%s|%s" "$PI_BUDGET" "$MODEL_KEY" "$DEV_INVOCATION_ID" "$PI_SESSION_ID"',
		],
		{ encoding: "utf8" },
	);
}

it("keeps each conversation's budget, credit and attribution for code reading process.env", async () => {
	vi.stubEnv("PI_BUDGET", "host-budget");
	vi.stubEnv("PI_CO_AUTHOR", "host-credit");
	vi.stubEnv("MODEL_KEY", undefined);
	root = mkdtempSync(join(tmpdir(), "two-conversations-"));
	const started = new SessionHost({ key: "two", owner, registryDir: root });
	host = started;
	const repoA = await conversation(started, "a", true);
	const repoB = await conversation(started, "b", false);

	// Interleaved, as a host serves them: B, then A, then B again.
	expect(started.run("b", childSees)).toBe("team-b|key-b|invocation-b|b");
	expect(started.run("a", childSees)).toBe("team-a|key-a|invocation-a|a");
	expect(
		started.run("b", () =>
			JSON.parse(process.env.SHOPIFY_HARNESS_SETTINGS ?? ""),
		),
	).toMatchObject({ surface: "background", launch_mode: "fresh" });
	expect(
		started.run("a", () =>
			JSON.parse(process.env.SHOPIFY_HARNESS_SETTINGS ?? ""),
		),
	).toMatchObject({ surface: "interactive", launch_mode: "fresh" });

	// Each repo's commit hook, run with no env, credits that conversation's model.
	for (const [id, repo] of [
		["a", repoA],
		["b", repoB],
	] as const) {
		const message = join(repo, "message");
		writeFileSync(message, "fix: test\n");
		started.run(id, () =>
			execFileSync("sh", [
				join(repo, ".git/hooks/prepare-commit-msg"),
				message,
			]),
		);
		expect(readFileSync(message, "utf8"), `${id}'s commit`).toContain(
			coAuthorTrailer(MODELS[id]),
		);
	}

	// The host's own env is as it was.
	expect(process.env.PI_BUDGET).toBe("host-budget");
	expect(process.env.PI_CO_AUTHOR).toBe("host-credit");
	expect(process.env.MODEL_KEY).toBeUndefined();
});
