import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import verificationWorkflow from "../../../extensions/verification-workflow/index.ts";
import { present } from "../../../extensions/verification-workflow/tree.ts";
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
import { endTurn } from "../../support/turn-end.ts";

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
		onUpdate?: unknown,
		ctx?: unknown,
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
			verify = {
				execute: (id, params, signal) =>
					tool.execute(id, params, signal, undefined, h.ctx),
			};
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
		cwd: process.cwd(),
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
	await endTurn(
		(name, event, at) => h.handlers.get(name)?.(event, at),
		{ message: { stopReason: "stop" }, toolResults: [] },
		h.ctx,
		{ boundary: true },
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
let path: string | undefined;

/** How long the slow git takes to answer, in seconds. */
const GIT_TAKES_S = 0.5;
/** How often a test's timer ticks while git answers. */
const TICK_MS = 20;

/** `text` quoted for sh, whatever it holds. */
function shQuoted(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The file a slowed git touches once it starts waiting. */
function gitWaiting(): string {
	return join(root, "git-waiting");
}

/** The file a held git waits on before it answers. */
function gitReleased(): string {
	return join(root, "git-released");
}

/** The real git, found before any test puts one of its own first. */
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
	encoding: "utf8",
}).trim();

/**
 * Put a git first on PATH that does `then` when its arguments hold
 * `only`, and runs the real one at once otherwise.
 */
function gitThat(then: string, only: string): void {
	const real = REAL_GIT;
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const git = join(bin, "git");
	writeFileSync(
		git,
		`#!/bin/sh\ncase " $* " in *${shQuoted(only)}*) ${then} ;; esac\n` +
			`exec ${shQuoted(real)} "$@"\n`,
	);
	chmodSync(git, 0o755);
	path ??= process.env.PATH;
	process.env.PATH = `${bin}:${path ?? ""}`;
}

/**
 * A git that waits `seconds` when its arguments hold `only`, saying so
 * in `gitWaiting()` first.
 */
function slowGit(seconds: number, only: string): void {
	gitThat(`: > ${shQuoted(gitWaiting())}; sleep ${seconds}`, only);
}

/** A git that fails whenever its arguments hold `only`. */
function failingGit(only: string): void {
	gitThat("exit 1", only);
}

/**
 * A git that, when its arguments hold `only`, says so in `gitWaiting()`
 * and waits for `gitReleased()` before answering.
 */
function heldGit(only: string, except?: string): void {
	const waiting = shQuoted(gitWaiting());
	const released = shQuoted(gitReleased());
	const hold = `: > ${waiting}; while [ ! -e ${released} ]; do sleep 0.05; done`;
	const there = except === undefined ? "" : shQuoted(realpathSync(except));
	gitThat(
		except === undefined
			? hold
			: `case "$(pwd -P)" in ${there}) ;; *) ${hold} ;; esac`,
		only,
	);
}

/** A git that counts in `file` each time its arguments hold `only`. */
function countingGit(file: string, only: string): void {
	gitThat(`echo >> ${shQuoted(file)}`, only);
}

/** How many times a counting git wrote to `file`. */
function counted(file: string): number {
	return existsSync(file) ? readFileSync(file, "utf8").length : 0;
}

/**
 * Start a failing verify of the repository, and once it waits on git
 * for its fingerprint, end another verify in `other` with `then`.
 */
async function verifyEndsMeanwhile(
	h: Harness,
	other: string,
	then: string,
): Promise<void> {
	// The other's git answers at once, so the repository's ends last.
	heldGit(" status ", other);
	h.questVerify = "exit 1";
	const failing = h.verify.execute("call", { path: repo }, undefined);
	await vi.waitFor(() =>
		expect(existsSync(gitWaiting()), "git asked").toBe(true),
	);
	h.questVerify = then;
	await h.verify.execute("call", { path: other }, undefined);
	// Only now may the first verify's git answer, so the other has ended.
	writeFileSync(gitReleased(), "");
	await failing;
}

/** A fresh repository holding a project. */
async function projectRepo(): Promise<string> {
	const made = await freshRepo("verify-fresh");
	writeFileSync(join(made, "package.json"), '{"name":"fixture"}\n');
	return made;
}

/**
 * Hold back a commit on a failed run while the git whose arguments hold
 * `only` takes its time, and show timers ran meanwhile.
 */
async function freeWhileGitAnswers(only: string): Promise<void> {
	repo = await freshRepo("verify-slow");
	writeFileSync(join(repo, "package.json"), '{"name":"fixture"}\n');
	const h = await harness();
	h.questVerify = "exit 1";
	await h.verify.execute("call", { path: repo }, undefined);
	slowGit(GIT_TAKES_S, only);

	let ticks = 0;
	const ticking = setInterval(() => {
		ticks += 1;
	}, TICK_MS);
	try {
		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	} finally {
		clearInterval(ticking);
	}

	// The slowed git takes half a second, so a free thread ticks many
	// times; one held by it ticks at most once, after it lets go.
	expect(ticks, "timers ran while git answered").toBeGreaterThan(5);
}

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
	if (path !== undefined) process.env.PATH = path;
	path = undefined;
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

	// Each git a commit's check asks is slowed in turn, so any one of them
	// held on the thread would stop the timer for the whole delay.
	it("leaves the thread free while a commit's check asks git what changed", async () => {
		await freeWhileGitAnswers(" status ");
	}, 20_000);

	it("leaves the thread free while a commit's check asks git for its commit", async () => {
		await freeWhileGitAnswers(" HEAD^{tree} ");
	}, 20_000);

	it("leaves the thread free while a commit's check asks git for its repository", async () => {
		await freeWhileGitAnswers(" --show-toplevel ");
	}, 20_000);

	it("records no failure a later verify of its project answered for meanwhile", async () => {
		repo = await projectRepo();
		const h = await harness();

		await verifyEndsMeanwhile(h, repo, "true");

		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		// Not even kept unknown: only the footer tells the two apart.
		expect(h.statuses.at(-1), "nothing left failing").toBeUndefined();
	}, 20_000);

	it("keeps the failure of another project that ended meanwhile, as the last to end", async () => {
		repo = await projectRepo();
		const h = await harness();
		const other = project("other");

		await verifyEndsMeanwhile(h, other, "exit 1");

		const held = await currentVerificationFailure({ dir: other });
		expect(held?.problems[0]).toContain(`exit 1 failed in ${other}`);
	}, 20_000);

	it("records a failure while a verify of another project ends", async () => {
		repo = await projectRepo();
		const h = await harness();

		await verifyEndsMeanwhile(h, project("other"), "true");

		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	}, 20_000);

	it("records a failure while a verify that checked nothing ends", async () => {
		repo = await projectRepo();
		const h = await harness();

		await verifyEndsMeanwhile(h, repo, "biome-is-not-installed-here check .");

		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	}, 20_000);

	it("keeps a failure git couldn't fingerprint, holding back no commit", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		failingGit(" status ");

		const result = await h.verify.execute("call", { path: repo }, undefined);

		expect(result.details.outcome).toBe("failing");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		expect(h.statuses.at(-1), "still said failing").toBeDefined();
	});

	it("retires a failed run once its repository is gone", async () => {
		repo = await projectRepo();
		const gone = repo;
		const h = await harness();
		h.questVerify = "exit 1";
		await h.verify.execute("call", { path: gone }, undefined);

		disposeRepo(gone);

		expect(await currentVerificationFailure({ dir: gone })).toBeUndefined();
		// A run kept unknown holds nothing back either; only the footer
		// tells a retired run from a kept one.
		expect(h.statuses.at(-1), "no longer failing").toBeUndefined();
	});

	it("retires a failure git couldn't fingerprint once its repository is gone", async () => {
		repo = await projectRepo();
		const gone = repo;
		const h = await harness();
		h.questVerify = "exit 1";
		failingGit(" status ");
		await h.verify.execute("call", { path: gone }, undefined);
		expect(h.statuses.at(-1), "kept as failing").toBeDefined();

		disposeRepo(gone);

		expect(await currentVerificationFailure({ dir: gone })).toBeUndefined();
		expect(h.statuses.at(-1), "no longer failing").toBeUndefined();
	});

	it("keeps a failure whose repository git didn't name, holding back no commit", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		failingGit(" --show-toplevel ");

		const result = await h.verify.execute("call", { path: repo }, undefined);

		expect(result.details.outcome).toBe("failing");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		expect(h.statuses.at(-1), "still said failing").toBeDefined();
	});

	it("keeps a failed run while git won't say what it sits on", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		await h.verify.execute("call", { path: repo }, undefined);

		// Past git's own wall, so it gives no answer at all.
		slowGit(10, " HEAD^{tree} ");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		if (path !== undefined) process.env.PATH = path;

		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	}, 20_000);

	it("keeps a failed run while git fails to say what it sits on", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		await h.verify.execute("call", { path: repo }, undefined);

		// Failing as no commit yet never does: it says nothing of the tree.
		gitThat("echo 'fatal: unable to read' >&2; exit 128", " HEAD^{tree} ");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		if (path !== undefined) process.env.PATH = path;

		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	});

	it("keeps a failed run while git's status says too much to read", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		await h.verify.execute("call", { path: repo }, undefined);

		// Past the mebibyte a status may print.
		gitThat("head -c 1100000 /dev/zero | tr '\\0' a; exit 0", " status ");
		expect(await currentVerificationFailure({ dir: repo })).toBeUndefined();
		expect(h.statuses.at(-1), "still said failing").toBeDefined();
		if (path !== undefined) process.env.PATH = path;

		const held = await currentVerificationFailure({ dir: repo });
		expect(held?.problems[0]).toContain("exit 1 failed in");
	});

	it("fingerprints a failing run's tree once", async () => {
		repo = await projectRepo();
		const h = await harness();
		h.questVerify = "exit 1";
		const asked = join(root, "statuses");
		countingGit(asked, " status ");

		await h.verify.execute("call", { path: repo }, undefined);

		expect(counted(asked), "statuses asked").toBe(1);
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

	it("outside git, holds back a commit whatever language git speaks", async () => {
		const h = await harness();
		const tree = project("plain");
		h.questVerify = "exit 1";
		// A git that answers in German unless asked for its own words.
		gitThat(
			'[ "$LC_ALL" = C ] || { echo "fatal: Kein Git-Repository" >&2; exit 128; }',
			" --show-toplevel ",
		);
		const language = process.env.LC_ALL;
		process.env.LC_ALL = "de_DE.UTF-8";
		try {
			await h.verify.execute("call", { path: tree }, undefined);
		} finally {
			if (language === undefined) delete process.env.LC_ALL;
			else process.env.LC_ALL = language;
		}

		expect(await currentVerificationFailure({ dir: tree })).toBeDefined();
	});
});

describe("whether a run's root is still there", () => {
	it("is gone only once the disk says it isn't there", async () => {
		const file = join(root, "file");
		writeFileSync(file, "");

		expect(await present(root), "a folder there").toBe(true);
		expect(await present(join(root, "missing")), "nothing there").toBe(false);
		expect(await present(join(file, "inner")), "under a file").toBe(false);
	});

	it("takes a root out of reach for now as still there", async () => {
		const locked = join(root, "locked");
		mkdirSync(join(locked, "inner"), { recursive: true });
		chmodSync(locked, 0o000);
		try {
			expect(await present(join(locked, "inner")), "out of reach").toBe(true);
		} finally {
			chmodSync(locked, 0o755);
		}
	});
});
