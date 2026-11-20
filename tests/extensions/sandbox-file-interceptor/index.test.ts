/**
 * In a strict session, pi's own file tools reach only what a fenced
 * command could, through every link in the path they name, and a session
 * with no sandbox is let through untouched.
 *
 * Each case lays out a made-up home folder holding a token file, and a
 * working folder beside it, so nothing of the person's is read.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sandboxFileInterceptor from "../../../extensions/sandbox-file-interceptor/index.ts";
import { type Host, installHost } from "../../../lib/core/session/host.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import type { Refusal } from "../../../lib/internal/fence/fence-log.ts";
import { FENCE_UNSAID } from "../../../lib/internal/sandbox/fence-told.ts";
import {
	fileToolFence,
	fileToolRefusal,
	toolPaths,
} from "../../../lib/internal/sandbox/sandbox-files.ts";
import { offerShellEnvironment } from "../../../lib/internal/shell/environment.ts";
import {
	cutTreeDir,
	treeRecordDir,
} from "../../../lib/internal/work-records.ts";

// What the interceptor would write to the system's log, kept here rather
// than written to the machine's real one.
const logged = vi.hoisted(() => ({
	refusals: [] as Refusal[],
	answer: undefined as string | undefined,
}));
vi.mock("../../../lib/internal/fence/fence-log.ts", () => ({
	recordRefusal: async (refusal: Refusal) => {
		logged.refusals.push(refusal);
		return logged.answer;
	},
	systemLogger: () => "logger",
}));

let base: string;
let home: string;
let work: string;

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-file-")));
	home = join(base, "home");
	work = join(base, "work");
	mkdirSync(join(home, ".config/git"), { recursive: true });
	writeFileSync(join(home, ".npmrc"), "the-token-file\n");
	writeFileSync(join(home, ".config/git/config"), "[user]\n");
	mkdirSync(work);
	writeFileSync(join(work, "notes.md"), "work\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const strict = { PI_SANDBOX: "strict" };

/** Why the strict profile refuses `toolName` given `input`, in the work. */
function refusal(
	toolName: string,
	input: unknown,
	env: NodeJS.ProcessEnv = strict,
	cwd = work,
): string | undefined {
	return fileToolRefusal({ toolName, input }, { cwd, env, home });
}

describe("a session with no sandbox", () => {
	it("reads anywhere, as pi does", () => {
		expect(refusal("read", { path: "~/.npmrc" }, {})).toBeUndefined();
	});
});

describe("a strict session's reads", () => {
	it("reach the work, by any way of naming it", () => {
		for (const path of ["notes.md", "@notes.md", join(work, "notes.md")]) {
			expect(refusal("read", { path })).toBeUndefined();
		}
		expect(refusal("grep", { pattern: "work" })).toBeUndefined();
		expect(refusal("ls", {})).toBeUndefined();
	});

	it("reach git's settings in the home folder, and the store", () => {
		expect(refusal("read", { path: "~/.config/git/config" })).toBeUndefined();
		expect(refusal("ls", { path: "/nix/store" })).toBeUndefined();
	});

	it("never reach a token file in the home folder", () => {
		for (const path of ["~/.npmrc", join(home, ".npmrc"), "../home/.npmrc"]) {
			expect(refusal("read", { path })).toContain("didn't run");
		}
		expect(refusal("ls", { path: "~" })).toContain("didn't run");
		expect(refusal("grep", { pattern: "token", path: home })).toContain(
			"didn't run",
		);
	});

	it("never reach pi's own environment through /proc", () => {
		expect(refusal("read", { path: "/proc/self/environ" })).toContain(
			"didn't run",
		);
	});

	it("never follow a link made in the work to a token file", () => {
		symlinkSync(join(home, ".npmrc"), join(work, "innocent.md"));
		expect(refusal("read", { path: "innocent.md" })).toContain(
			`leads to ${join(home, ".npmrc")}`,
		);
	});

	it("check each spelling pi tries for a missing file", () => {
		symlinkSync(join(home, ".npmrc"), join(work, "it\u2019s.md"));
		expect(toolPaths("it's.md", work, home)).toContain(
			join(work, "it\u2019s.md"),
		);
		expect(refusal("read", { path: "it's.md" })).toContain("didn't run");
	});

	it("reach the skills pi offered the session, and never write them", () => {
		const skill = join(home, ".pi/agent/skills/review-format");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "# Format\n");
		const offered = (toolName: string) =>
			fileToolRefusal(
				{ toolName, input: { path: join(skill, "SKILL.md") } },
				{ cwd: work, env: strict, home, skills: [skill] },
			);
		expect(offered("read")).toBeUndefined();
		expect(offered("write")).toContain("may write only");
		expect(refusal("read", { path: join(skill, "SKILL.md") })).toContain(
			"didn't run",
		);
	});

	it("refuse a loop of links rather than chase it", () => {
		symlinkSync(join(work, "b"), join(work, "a"));
		symlinkSync(join(work, "a"), join(work, "b"));
		expect(refusal("read", { path: "a" })).toContain("loop of links");
	});
});

describe("a fenced session's reads of a hidden key", () => {
	it("name the route for that file: secret_run for a key, the shell for ~/.npmrc", () => {
		// On 15 November a read of a hidden credential named only the
		// ~/.npmrc route, which is no way to that file.
		const key = join(home, ".local/state/nix-offload/store_ed25519");
		mkdirSync(join(home, ".local/state/nix-offload"), { recursive: true });
		writeFileSync(key, "private\n");
		const fence = { PI_SANDBOX: "fence" };
		const ofKey = refusal("read", { path: key }, fence) ?? "";
		const ofNpmrc =
			refusal("read", { path: join(home, ".npmrc") }, fence) ?? "";
		expect(
			{
				keyNamesSecretRun: ofKey.includes("secret_run"),
				keyNamesNpmrc: ofKey.includes("~/.npmrc"),
				npmrcNamesItsCopy: ofNpmrc.includes(
					"reads ~/.npmrc without its tokens",
				),
			},
			"the routes each refusal names",
		).toEqual({
			keyNamesSecretRun: true,
			keyNamesNpmrc: false,
			npmrcNamesItsCopy: true,
		});
	});
});

describe("a strict session's writes", () => {
	it("reach the work, a file not yet made among them", () => {
		expect(refusal("write", { path: "new/deeper/file.md" })).toBeUndefined();
		expect(refusal("edit", { path: "notes.md" })).toBeUndefined();
	});

	it("never reach what it may only read", () => {
		expect(refusal("edit", { path: "~/.config/git/config" })).toContain(
			"may write only",
		);
	});

	it("never follow a dangling link out of the work", () => {
		symlinkSync(join(home, ".zshrc"), join(work, "startup"));
		expect(refusal("write", { path: "startup" })).toContain(
			`leads to ${join(home, ".zshrc")}`,
		);
	});
});

describe("a strict session the sandbox can't fence", () => {
	it("runs no file tool in the home folder", () => {
		expect(refusal("read", { path: ".npmrc" }, strict, home)).toContain(
			"file tools don't read there either",
		);
	});

	it("reads a plain clone but never writes it, where git's hooks are", () => {
		mkdirSync(join(work, ".git/hooks"), { recursive: true });
		expect(refusal("read", { path: "notes.md" })).toBeUndefined();
		expect(refusal("write", { path: ".git/hooks/post-checkout" })).toContain(
			"file tools don't write there either",
		);
	});

	it("fences them where PI_SANDBOX names no sandbox, as the shell does", () => {
		const write = { path: "~/.bashrc", content: "x" };
		const fenced = refusal("write", write, { PI_SANDBOX: "fence" });
		expect(fenced, "the fence let a startup file be written").toBeDefined();
		for (const given of ["loose", ""]) {
			expect(
				refusal("write", write, { PI_SANDBOX: given }),
				`PI_SANDBOX=${JSON.stringify(given)} wasn't read as the fence`,
			).toBe(fenced);
		}
		expect(
			refusal("write", write, { PI_SANDBOX: "off" }),
			"off was fenced",
		).toBeUndefined();
	});

	it("fences them in the first stage unasked, but never past off", () => {
		const call = {
			toolName: "write",
			input: { path: "~/.bashrc", content: "x" },
		};
		const inStage = () => true;
		expect(
			fileToolRefusal(call, { cwd: work, env: {}, home, staged: inStage }),
			"a staged session's file tools weren't fenced",
		).toBe(refusal("write", call.input, { PI_SANDBOX: "fence" }));
		expect(
			fileToolRefusal(call, {
				cwd: work,
				env: { PI_SANDBOX: "off" },
				home,
				staged: inStage,
			}),
			"off was fenced in the stage",
		).toBeUndefined();
	});

	it("runs none whose path it can't check", () => {
		expect(refusal("read", { path: 7 })).toContain("named none it could check");
	});

	it("leaves any tool but pi's file tools alone", () => {
		expect(refusal("bash", { command: "cat ~/.npmrc" })).toBeUndefined();
	});
});

describe("the fence pi's file tools hold a call to", () => {
	const read = { toolName: "read", input: { path: "notes.md" } };
	const never = () => false;

	it("is the one each sandbox's name asks for, as the refusal reads it", () => {
		expect(
			[
				{ PI_SANDBOX: "strict" },
				{ PI_SANDBOX: "fence" },
				{ PI_SANDBOX: "off" },
				{ PI_SANDBOX: "vm" },
				{},
			].map((env) => fileToolFence(read, env, never)),
		).toEqual(["strict", "fence", "none", "fence", "none"]);
	});

	it("is the fence in the first stage unasked", () => {
		expect(fileToolFence(read, {}, () => true)).toBe("fence");
	});

	it("is nothing for any tool but pi's file tools", () => {
		expect(
			fileToolFence({ toolName: "bash", input: {} }, {}, never),
		).toBeUndefined();
	});
});

describe("the interceptor", () => {
	type Handler = (
		event: { toolName: string; input: unknown },
		ctx: {
			cwd: string;
			sessionManager: { getSessionId: () => string };
		},
	) => Promise<unknown>;
	type Starting = (event: {
		messageType?: string;
		systemPromptOptions: { skills: Array<{ baseDir: string }> };
	}) => Promise<unknown>;
	let handler: Handler;
	let starting: Starting;
	let sessionStart: unknown;
	let sessionShutdown: unknown;
	let asked: string | undefined;
	const seat = () => ({
		cwd: work,
		sessionManager: { getSessionId: () => "a-session" },
	});

	beforeEach(() => {
		asked = process.env.PI_SANDBOX;
		logged.refusals = [];
		logged.answer = undefined;
		const handlers = new Map<string, unknown>();
		const pi = { on: (name: string, on: unknown) => handlers.set(name, on) };
		sandboxFileInterceptor(pi as unknown as ExtensionAPI);
		const registered = handlers.get("tool_call");
		const start = handlers.get("before_agent_start");
		if (typeof registered !== "function" || typeof start !== "function") {
			throw new Error("the fence never listened for calls and skills");
		}
		handler = registered as Handler;
		starting = start as Starting;
		sessionStart = handlers.get("session_start");
		sessionShutdown = handlers.get("session_shutdown");
	});

	afterEach(() => {
		if (asked === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = asked;
	});

	it("tells a host its file tools' fence as its runner starts, before any call", async () => {
		const told: [string, string, string][] = [];
		const uninstall = installHost({
			fenced: (id: string, fence: string, by: string) => {
				told.push([id, fence, by]);
				return true;
			},
		} as unknown as Host);
		try {
			process.env.PI_SANDBOX = "strict";
			expect(
				typeof sessionStart,
				"the guard never heard its runner start",
			).toBe("function");
			// A host runs each call within its conversation.
			await withSession("a-session", () =>
				(sessionStart as (event: unknown, ctx: unknown) => Promise<unknown>)(
					{ type: "session_start" },
					seat(),
				),
			);
		} finally {
			uninstall();
		}
		// The host names a fence only once this guard has told one, since a
		// runner without it leaves pi's file tools unfenced.
		expect(told).toEqual([["a-session", "strict", "files"]]);
	});

	it("tells a host it left as its runner shuts down, naming the session it started in", async () => {
		const told: string[][] = [];
		const uninstall = installHost({
			fenced: () => true,
			left: (id: string) => told.push([id, "left"]),
		} as unknown as Host);
		try {
			expect(
				typeof sessionShutdown,
				"the guard never heard its runner shut down",
			).toBe("function");
			await withSession("a-session", () =>
				(sessionStart as (event: unknown, ctx: unknown) => Promise<unknown>)(
					{ type: "session_start" },
					seat(),
				),
			);
			// Its context may not be read once the runner is gone, so none.
			await (sessionShutdown as (event: unknown, ctx: unknown) => unknown)(
				{ type: "session_shutdown" },
				undefined,
			);
		} finally {
			uninstall();
		}
		// A runner whose shell never loaded is judged as it ends, whoever
		// reloads it, since pi's own bash ran unfenced.
		expect(told).toEqual([["a-session", "left"]]);
	});

	it("tells a host the fence it holds each file call to, before the call runs", async () => {
		const told: [string, string, string][] = [];
		const uninstall = installHost({
			fenced: (id: string, fence: string, by: string) => {
				told.push([id, fence, by]);
				return true;
			},
		} as unknown as Host);
		// A host runs each call within its conversation.
		const call = (toolName: string, input: unknown) =>
			withSession("a-session", () => handler({ toolName, input }, seat()));
		let refused: unknown;
		try {
			process.env.PI_SANDBOX = "off";
			const path = join(work, "notes.md");
			await call("read", { path });
			process.env.PI_SANDBOX = "strict";
			// Told even of a call the fence goes on to refuse, so it was told
			// before the call was judged.
			refused = await call("read", { path: "/proc/self/environ" });
			await call("bash", { command: "true" });
		} finally {
			uninstall();
		}
		expect(refused, "the strict read went through").toMatchObject({
			block: true,
		});
		expect(told).toEqual([
			["a-session", "none", "files"],
			["a-session", "strict", "files"],
		]);
	});

	it("refuses a file call whose fence its host couldn't write", async () => {
		const uninstall = installHost({
			fenced: () => false,
		} as unknown as Host);
		let answer: unknown;
		try {
			process.env.PI_SANDBOX = "off";
			answer = await withSession("a-session", () =>
				handler(
					{ toolName: "read", input: { path: join(work, "notes.md") } },
					seat(),
				),
			);
		} finally {
			uninstall();
		}
		expect(answer).toEqual({ block: true, reason: FENCE_UNSAID });
	});

	it("blocks a strict session's read outside the fence, saying why", async () => {
		process.env.PI_SANDBOX = "strict";
		const answer = await handler(
			{ toolName: "read", input: { path: "/proc/self/environ" } },
			seat(),
		);
		expect(answer).toMatchObject({ block: true });
		expect(JSON.stringify(answer)).toContain("didn't run");
	});

	it("writes each refusal to the system's log, as a kind, never the path", async () => {
		process.env.PI_SANDBOX = "strict";
		await handler(
			{ toolName: "write", input: { path: "/proc/self/environ" } },
			seat(),
		);
		expect(logged.refusals, "what the log was handed").toEqual([
			{ kind: "path", tool: "write", sandbox: "strict", session: "a-session" },
		]);
	});

	it("says in the refusal when the log didn't take it", async () => {
		process.env.PI_SANDBOX = "strict";
		logged.answer = "The system log didn't take this refusal: gone.";
		const answer = await handler(
			{ toolName: "read", input: { path: "/proc/self/environ" } },
			seat(),
		);
		expect(
			JSON.stringify(answer),
			"the refusal hid the log's failure",
		).toContain("didn't take this refusal: gone.");
	});

	it("reads the skills pi offered as the session started", async () => {
		process.env.PI_SANDBOX = "strict";
		const skill = join(home, "skills/review-format");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "# Format\n");
		await starting({ systemPromptOptions: { skills: [{ baseDir: skill }] } });
		const answer = await handler(
			{ toolName: "read", input: { path: join(skill, "SKILL.md") } },
			seat(),
		);
		expect(answer).toBeUndefined();
	});

	it("reads the skills pi offered a run a host carried on after a restart", async () => {
		process.env.PI_SANDBOX = "strict";
		const skill = join(home, "skills/review-format");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "# Format\n");
		await starting({
			messageType: "continue",
			systemPromptOptions: { skills: [{ baseDir: skill }] },
		});
		const answer = await handler(
			{ toolName: "read", input: { path: join(skill, "SKILL.md") } },
			seat(),
		);
		expect(answer).toBeUndefined();
	});

	describe("in a fenced session on a quest", () => {
		let scratch: string;

		beforeEach(() => {
			process.env.PI_SANDBOX = "fence";
			vi.stubEnv("XDG_CACHE_HOME", join(base, "cache"));
			const root = join(base, "cache/pi/agentic-harness.pi/quest-workspace");
			mkdirSync(join(root, "QEST-1/tmp"), { recursive: true });
			mkdirSync(join(root, "QEST-2/tmp"), { recursive: true });
			scratch = join(base, "pi-quest-QEST-1");
			symlinkSync(join(root, "QEST-1/tmp"), scratch);
			// The quest workflow offers its TMPDIR to the agent's commands
			// only; pi's own environment never names it.
			offerShellEnvironment("quest-workflow", () => ({ TMPDIR: scratch }));
		});

		afterEach(() => {
			offerShellEnvironment("quest-workflow", undefined);
			vi.unstubAllEnvs();
		});

		it("writes in the quest's own scratch, as its commands do", async () => {
			const answer = await handler(
				{
					toolName: "write",
					input: { path: join(scratch, "report.txt"), content: "x" },
				},
				seat(),
			);
			expect(answer, "the write tool refused its own scratch").toBeUndefined();
		});

		it("writes in a tree the session holds, whatever pi's own environment names", async () => {
			// On 15 November ISXEG8's fenced session had every write to the
			// trees it held refused, where its commands wrote them: pi's own
			// environment named no session, or the one it started as, and
			// the records name the conversation holding each tree.
			vi.stubEnv("XDG_STATE_HOME", join(base, "state"));
			vi.stubEnv("PI_SESSION_ID", "the-session-pi-started-as");
			const tree = join(cutTreeDir(), "worktree-held");
			mkdirSync(tree, { recursive: true });
			mkdirSync(treeRecordDir(), { recursive: true });
			writeFileSync(
				join(treeRecordDir(), "worktree-held.json"),
				JSON.stringify({
					identity: { key: "worktree-held", shareable: false },
					path: tree,
					providerId: "git-worktree",
					sessions: ["a-session"],
				}),
			);
			const answer = await handler(
				{
					toolName: "write",
					input: { path: join(tree, "notes.md"), content: "x" },
				},
				seat(),
			);
			expect(answer, "the write tool refused a held tree").toBeUndefined();
		});

		it("writes in the quest's own shared folder, even before any command made it", async () => {
			const answer = await handler(
				{
					toolName: "write",
					input: {
						path: join(
							base,
							"cache/pi/agentic-harness.pi/quest-shares/QEST-1/notes.md",
						),
						content: "x",
					},
				},
				seat(),
			);
			expect(answer, "the write tool refused its own share").toBeUndefined();
		});

		it("never writes in another quest's shared folder", async () => {
			const other = join(
				base,
				"cache/pi/agentic-harness.pi/quest-shares/QEST-2/x.txt",
			);
			mkdirSync(dirname(other), { recursive: true });
			const answer = await handler(
				{ toolName: "write", input: { path: other, content: "x" } },
				seat(),
			);
			expect(answer, "another quest's share took a write").toMatchObject({
				block: true,
			});
		});

		it("never writes in another quest's scratch", async () => {
			const other = join(
				base,
				"cache/pi/agentic-harness.pi/quest-workspace/QEST-2/tmp/x.txt",
			);
			const answer = await handler(
				{ toolName: "write", input: { path: other, content: "x" } },
				seat(),
			);
			expect(answer, "another quest's scratch took a write").toMatchObject({
				block: true,
			});
		});
	});

	it("lets a session with no sandbox read as it likes", async () => {
		delete process.env.PI_SANDBOX;
		const answer = await handler(
			{ toolName: "read", input: { path: "/proc/self/environ" } },
			seat(),
		);
		expect(answer).toBeUndefined();
		expect(logged.refusals, "a call let through was logged").toEqual([]);
	});
});
