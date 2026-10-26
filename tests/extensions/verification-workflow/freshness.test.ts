import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import verificationWorkflow from "../../../extensions/verification-workflow/index.ts";
import {
	clearLspBackends,
	type Diagnostic,
	type LspBackend,
	registerLspBackend,
} from "../../../lib/core/lsp/index.ts";
import {
	currentVerificationFailure,
	provideVerificationCheck,
} from "../../../lib/internal/verification/signal.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

/**
 * Whether what verification says is about the code as it stands.
 *
 * A commit was refused for errors that had been fixed minutes before,
 * because the refusal read a flag only the end of a turn refreshed, and
 * then again because verify ran in the checkout the session started in,
 * which had no node_modules, rather than the worktree being edited. A
 * commit now gets an answer checked when it asks, in its own tree.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

interface VerifyTool {
	execute: (
		id: string,
		params: { path?: string },
		signal: AbortSignal | undefined,
	) => Promise<{
		content: { text: string }[];
		details: { outcome: string; dir: string };
	}>;
}

interface Harness {
	readonly handlers: Map<string, Handler>;
	readonly sendMessage: ReturnType<typeof vi.fn>;
	readonly statuses: Array<string | undefined>;
	readonly verify: VerifyTool;
	readonly ctx: unknown;
	/** The check command a quest names, which verify runs first. */
	questVerify?: string;
}

/** The workflow started in a session, as a fake pi saw it. */
async function harness(): Promise<Harness> {
	const handlers = new Map<string, Handler>();
	let verify: VerifyTool | undefined;
	const h: Harness = {
		handlers,
		sendMessage: vi.fn(),
		statuses: [],
		get verify(): VerifyTool {
			if (!verify) throw new Error("verify was not registered");
			return verify;
		},
		get ctx(): unknown {
			return context(h);
		},
	};
	verificationWorkflow({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: VerifyTool) => {
			verify = tool;
		},
		registerMessageRenderer() {},
		sendMessage: h.sendMessage,
		events: { on() {}, emit() {} },
	} as never);
	await handlers.get("session_start")?.({}, h.ctx);
	return h;
}

function context(h: Harness): unknown {
	return {
		signal: undefined,
		sessionManager: {
			getEntries: () =>
				h.questVerify
					? [
							{
								type: "custom",
								customType: "quest-workflow",
								data: { verify: h.questVerify },
							},
						]
					: [],
		},
		ui: {
			theme: { fg: (colour: string, text: string) => `${colour}:${text}` },
			setStatus: (_key: string, label: string | undefined) =>
				h.statuses.push(label),
		},
	};
}

async function edit(h: Harness, path: string): Promise<void> {
	await h.handlers.get("tool_result")?.(
		{ toolName: "edit", isError: false, input: { path } },
		h.ctx,
	);
}

/** End a turn that is about to yield, which runs the fast layer. */
async function yieldTurn(h: Harness): Promise<void> {
	await h.handlers.get("turn_end")?.(
		{ message: { stopReason: "stop" }, toolResults: [] },
		h.ctx,
	);
}

const anError = {
	severity: "error",
	message: "Property 'body' does not exist",
	range: {
		start: { line: 78, character: 12 },
		end: { line: 78, character: 16 },
	},
} as unknown as Diagnostic;

/** Serve diagnostics from `answer`, keeping each path asked about. */
function serve(asked: string[], answer: (path: string) => boolean): void {
	const never = (): Promise<never> => new Promise(() => {});
	const backend: LspBackend = {
		name: "test",
		diagnostics: async (path) => {
			asked.push(path);
			return answer(path) ? [anError] : [];
		},
		definition: never,
		references: never,
		hover: never,
		documentSymbols: never,
		workspaceSymbols: never,
		rename: never,
		codeActions: never,
		dispose: async () => {},
	};
	clearLspBackends();
	registerLspBackend({
		name: "test",
		priority: 1,
		isAvailable: () => true,
		backend,
	});
}

let root: string;
let repo: string | undefined;

/** A project directory with a package.json, outside any repository. */
function project(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n');
	return dir;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "verify-fresh-"));
});

afterEach(() => {
	clearLspBackends();
	provideVerificationCheck(undefined);
	disposeRepo(repo);
	repo = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("a commit asking whether anything is failing", () => {
	it("stops being refused once the file is fixed, with no turn ending between", async () => {
		const asked: string[] = [];
		let broken = true;
		serve(asked, () => broken);
		const h = await harness();
		const tree = project("tree");
		const file = join(tree, "document.ts");

		await edit(h, file);
		await yieldTurn(h);
		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		expect((await currentVerificationFailure({ dir: tree }))?.problems).toEqual(
			[`${file}:78:12 Property 'body' does not exist`],
		);

		expect(h.statuses.at(-1)).toMatch(/^error:\u2715/);

		broken = false;
		expect(await currentVerificationFailure({ dir: tree })).toBeUndefined();
		// Clean is a calm footer: nothing there at all.
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("judges only the repository the commit lands in", async () => {
		const asked: string[] = [];
		serve(asked, () => true);
		const h = await harness();
		await edit(h, join(project("one"), "a.ts"));
		await yieldTurn(h);
		asked.length = 0;

		const other = project("two");
		expect(await currentVerificationFailure({ dir: other })).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it("is not refused on errors nothing can confirm any more", async () => {
		serve([], () => true);
		const h = await harness();
		const tree = project("tree");
		await edit(h, join(tree, "a.ts"));
		await yieldTurn(h);

		clearLspBackends();
		expect(await currentVerificationFailure({ dir: tree })).toBeUndefined();
	});
});

describe("the fast layer saying what it found", () => {
	it("says an error set once, however many turns it lasts", async () => {
		serve([], () => true);
		const h = await harness();
		const file = join(project("tree"), "a.ts");

		await edit(h, file);
		await yieldTurn(h);
		await edit(h, file);
		await yieldTurn(h);
		await yieldTurn(h);

		expect(h.sendMessage).toHaveBeenCalledTimes(1);
		// Still failing, and the footer still says so.
		expect(h.statuses.at(-1)).toMatch(/^error:\u2715/);
	});

	it("speaks again once the errors change, or come back after a clean pass", async () => {
		const asked: string[] = [];
		let broken = new Set<string>();
		serve(asked, (path) => broken.has(path));
		const h = await harness();
		const tree = project("tree");
		const a = join(tree, "a.ts");
		const b = join(tree, "b.ts");

		broken = new Set([a]);
		await edit(h, a);
		await yieldTurn(h);
		broken = new Set([a, b]);
		await edit(h, b);
		await yieldTurn(h);
		expect(h.sendMessage).toHaveBeenCalledTimes(2);

		broken = new Set();
		await yieldTurn(h);
		broken = new Set([a]);
		await edit(h, a);
		await yieldTurn(h);
		expect(h.sendMessage).toHaveBeenCalledTimes(3);
	});

	it("leaves a quest workspace's scratch files alone", async () => {
		const asked: string[] = [];
		serve(asked, () => true);
		const cache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = join(root, "cache");
		try {
			const h = await harness();
			const scratch = join(
				root,
				"cache",
				"pi",
				"agentic-harness.pi",
				"quest-workspace",
				"QEST-20261012-AAAAAA",
				"lab",
				"eval.ts",
			);
			await edit(h, scratch);
			await yieldTurn(h);

			expect(asked).toEqual([]);
			expect(h.sendMessage).not.toHaveBeenCalled();
		} finally {
			if (cache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = cache;
		}
	});
});

describe("the verify tool", () => {
	it("checks the project the last edit landed in, and says so", async () => {
		const h = await harness();
		const tree = project("worktree");
		h.questVerify = "pwd";
		await edit(h, join(tree, "src.ts"));

		const result = await h.verify.execute("call", {}, undefined);

		expect(result.details.dir).toBe(tree);
		expect(result.content[0]?.text).toContain(`In ${tree}:`);
		expect(result.details.outcome).toBe("clean");
	});

	it("checks the project a path names, over the last edit", async () => {
		const h = await harness();
		const named = project("named");
		h.questVerify = "pwd";
		await edit(h, join(project("edited"), "src.ts"));

		const result = await h.verify.execute("call", { path: named }, undefined);

		expect(result.details.dir).toBe(named);
	});

	it("calls a check that could not start deferred, and holds back no commit", async () => {
		const h = await harness();
		const tree = project("bare");
		h.questVerify = "biome-is-not-installed-here check .";
		await edit(h, join(tree, "src.ts"));

		const result = await h.verify.execute("call", {}, undefined);

		expect(result.details.outcome).toBe("deferred");
		expect(result.content[0]?.text).toContain(
			"This says nothing about the code",
		);
		expect(await currentVerificationFailure({ dir: tree })).toBeUndefined();
		expect(h.statuses.at(-1)).toBeUndefined();
	});

	it("holds back a commit on a failed run until the tree changes", async () => {
		repo = await freshRepo("verify-fresh");
		writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
		const h = await harness();
		h.questVerify = "exit 1";

		const result = await h.verify.execute("call", { path: repo }, undefined);
		expect(result.details.outcome).toBe("failing");
		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");

		// Changed by something other than an edit, a formatter say.
		writeFileSync(join(repo, "formatted.ts"), "export {};\n");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
	});

	it("outside git, holds back a commit on a failed run until an edit there", async () => {
		const h = await harness();
		const tree = project("plain");
		h.questVerify = "exit 1";

		await h.verify.execute("call", { path: tree }, undefined);
		expect(await currentVerificationFailure({ dir: tree })).toBeDefined();

		await edit(h, join(tree, "fix.ts"));
		expect(await currentVerificationFailure({ dir: tree })).toBeUndefined();
	});
});
