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
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sandboxFileInterceptor from "../../extensions/sandbox-file-interceptor/index.ts";
import type { Refusal } from "../../lib/internal/fence-log.ts";
import {
	fileToolRefusal,
	toolPaths,
} from "../../lib/internal/sandbox-files.ts";

// What the interceptor would write to the system's log, kept here rather
// than written to the machine's real one.
const logged = vi.hoisted(() => ({
	refusals: [] as Refusal[],
	answer: undefined as string | undefined,
}));
vi.mock("../../lib/internal/fence-log.ts", () => ({
	recordRefusal: async (refusal: Refusal) => {
		logged.refusals.push(refusal);
		return logged.answer;
	},
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

	it("runs none where PI_SANDBOX names no sandbox", () => {
		expect(
			refusal("read", { path: "notes.md" }, { PI_SANDBOX: "loose" }),
		).toContain("No file tool runs");
	});

	it("runs none whose path it can't check", () => {
		expect(refusal("read", { path: 7 })).toContain("named none it could check");
	});

	it("leaves any tool but pi's file tools alone", () => {
		expect(refusal("bash", { command: "cat ~/.npmrc" })).toBeUndefined();
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
		systemPromptOptions: { skills: Array<{ baseDir: string }> };
	}) => Promise<unknown>;
	let handler: Handler;
	let starting: Starting;
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
	});

	afterEach(() => {
		if (asked === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = asked;
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
