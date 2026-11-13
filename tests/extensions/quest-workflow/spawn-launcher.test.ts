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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	FIRST_WORDS_VARIABLE,
	firstWordsDir,
} from "../../../lib/internal/quest/first-words.ts";
import { questAddress } from "../../../lib/mesh/address.ts";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
} from "../../../lib/terminal/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { createEnvGuard } from "./_helpers.ts";

// The launcher is asked through `qs` on PATH, so a stand-in `qs` writes
// down what it was asked and answers what the test tells it to. Asked
// whether the lock is up, it says what QS_LOCKED says, else no.
const FAKE_QS = `#!/bin/sh
if [ "$3" = lock ]; then printf '%s\\n' "\${QS_LOCKED:-false}"; exit 0; fi
printf '%s\\n' "$@" > "$QS_ASKED"
printf '%s\\n' "$QS_SAYS"
`;

const kept: Record<string, string | undefined> = {};
const KEPT = [
	"HOME",
	"PATH",
	"PI_CODING_AGENT_DIR",
	"PI_LAUNCHER",
	"XDG_CONFIG_HOME",
	"QS_ASKED",
	"QS_SAYS",
	"QS_LOCKED",
	"PI_SESSIONS_KITTY",
	"XDG_RUNTIME_DIR",
];

// The sessions kitty is opened through kitten over its socket, or through
// systemd-run before that kitty listens, so a stand-in for each writes
// down what it was asked to start, one word a line.
const FAKE_STARTER = `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/started"
`;

/** What the stand-in systemd-run was asked to start, if anything. */
function started(): string[] | undefined {
	const path = join(tmpRoot, "started");
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trimEnd().split("\n");
}
let tmpRoot: string;
let opened: string | undefined;
let openedEnv: Record<string, string> | undefined;

/** The words a spawn left for the session under `key`, if any. */
function wordsFor(key: string): string | undefined {
	const path = join(firstWordsDir(), `${key}.json`);
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as { words: string }).words;
}
const envGuard = createEnvGuard();

function fakeCtx(
	cwd: string,
	sessionId: string,
	model?: { provider: string; id: string; thinkingLevel: string },
) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => true },
		...(model
			? {
					model: { provider: model.provider, id: model.id },
					thinkingLevel: model.thinkingLevel,
				}
			: {}),
	} as unknown as Parameters<typeof handle>[2];
}

/** What the launcher was handed, or undefined when it wasn't asked. */
function handed(): unknown {
	const asked = process.env.QS_ASKED as string;
	if (!existsSync(asked)) return undefined;
	const words = readFileSync(asked, "utf8").trim().split("\n");
	expect(words.slice(0, 4)).toEqual(["ipc", "call", "sessions", "reopen"]);
	return JSON.parse(words[4] as string);
}

async function quest() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
		action: "create",
		title: "Alpha",
	});
	if (!created.ok) throw new Error(created.guidance);
	return { state, id: state.questId as string };
}

beforeEach(() => {
	envGuard.enter();
	for (const name of KEPT) kept[name] = process.env[name];
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-launcher-"));
	process.env.HOME = tmpRoot;
	const bin = join(tmpRoot, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "qs"), FAKE_QS);
	chmodSync(join(bin, "qs"), 0o755);
	for (const starter of ["systemd-run", "kitten"]) {
		writeFileSync(join(bin, starter), FAKE_STARTER);
		chmodSync(join(bin, starter), 0o755);
	}
	process.env.XDG_RUNTIME_DIR = join(tmpRoot, "run");
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.QS_ASKED = join(tmpRoot, "asked");
	process.env.QS_SAYS = "taken";
	delete process.env.PI_LAUNCHER;
	// The person's settings open a kitty window, as the launcher does.
	const config = join(tmpRoot, "config");
	mkdirSync(join(config, "pi", "agentic-harness.pi"), { recursive: true });
	writeFileSync(
		join(config, "pi", "agentic-harness.pi", "config.json"),
		JSON.stringify({
			version: 1,
			sections: {
				terminal: { defaults: { driver: "kitty", layout: "window" } },
			},
		}),
	);
	process.env.XDG_CONFIG_HOME = config;
	opened = undefined;
	openedEnv = undefined;
	rmSync(firstWordsDir(), { recursive: true, force: true });
	clearTerminalDrivers();
	registerTerminalDriver({
		id: "kitty",
		available: () => true,
		async spawn(req) {
			opened = req.command;
			openedEnv = req.env;
		},
	});
});
afterEach(() => {
	clearTerminalDrivers();
	for (const name of KEPT) {
		if (kept[name] === undefined) delete process.env[name];
		else process.env[name] = kept[name];
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("spawn through the desktop's launcher", () => {
	it("hands a new session to the launcher, fresh on its quest, and opens nothing itself", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as {
			sessions: { id: string; cwd: string; fresh: boolean; quest: string }[];
		};
		expect(given.sessions).toHaveLength(1);
		const [session] = given.sessions;
		// Without focus, beside the session that asked, which is "spawner".
		expect(session).toMatchObject({
			cwd: tmpRoot,
			fresh: true,
			quest: id,
			from: "spawner",
			focus: false,
		});
		expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
		// A new session takes nobody's place.
		expect(session).not.toHaveProperty("replaces");
		expect(opened).toBeUndefined();
		expect(result.message).toContain(`Handed a new session, ${session?.id}`);
	});

	it("hands a new session the model of the session that asked for it", async () => {
		// 11-09: a launcher pi is wrapped in changed pi's default model, and
		// every session spawned after ran on another model than its spawner.
		const { state, id } = await quest();
		const asking = fakeCtx(tmpRoot, "spawner", {
			provider: "anthropic",
			id: "claude-opus-5-5",
			thinkingLevel: "high",
		});
		const result = await handle(state, fakePi(), asking, {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: Record<string, unknown>[] };
		expect(given.sessions[0]).toMatchObject({
			fresh: true,
			model: "anthropic/claude-opus-5-5:high",
		});
		expect(opened).toBeUndefined();
	});

	it("leaves a command the caller gives on the model it names, or pi's default", async () => {
		const { state, id } = await quest();
		const asking = fakeCtx(tmpRoot, "spawner", {
			provider: "anthropic",
			id: "claude-opus-5-5",
			thinkingLevel: "high",
		});
		const result = await handle(state, fakePi(), asking, {
			action: "spawn",
			id,
			command: "pi",
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: Record<string, unknown>[] };
		expect(given.sessions[0]).toMatchObject({ fresh: true });
		expect(given.sessions[0]).not.toHaveProperty("model");
	});

	it("says the orchestrator and the title the new session's window is placed by", async () => {
		const quests = join(tmpRoot, "quests");
		const readme = (id: string, fields: string) => {
			mkdirSync(join(quests, id), { recursive: true });
			writeFileSync(
				join(quests, id, "README.md"),
				`---\nid: ${id}\nkind: quest\nstatus: active\nrank: 1\npriority: active\nstarted: 2026-01-01\nupdated: 2026-01-01\n${fields}\n---\n\n# ${id}\n`,
			);
		};
		readme("QEST-20260101-LEADER", "orchestrator: true\nshort: Lead");
		readme(
			"QEST-20260101-WORKER",
			"parent: QEST-20260101-LEADER\nshort: Edge Checks",
		);
		const state = createQuestState({ questsRoot: quests });

		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id: "QEST-20260101-WORKER",
		});

		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: Record<string, unknown>[] };
		expect(given.sessions[0]).toMatchObject({
			quest: "QEST-20260101-WORKER",
			from: "spawner",
			orchestratedBy: "LEADER",
			title: "Edge Checks",
		});
	});

	it("tells the session it hands over to carry on with its quest, and what for", async () => {
		// 7 of 9 builders spawned on 11-03 sat idle until pivoted.
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			note: "Build the slice weights from 5FWIUS's numbers.",
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: { id: string }[] };
		const words = wordsFor(given.sessions[0]?.id as string);
		expect(words).toMatch(/^\[Automated message, no human input: /);
		expect(words).toContain(`Carry on with ${id}`);
		expect(words).toContain("Build the slice weights from 5FWIUS's numbers.");
	});

	it("names the words in the window's environment when it opens one itself", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		const token = openedEnv?.[FIRST_WORDS_VARIABLE] as string;
		expect(wordsFor(token)).toContain(`Carry on with ${id}`);
	});

	it("hands a new pi the caller names a model for to the launcher, told its quest", async () => {
		// 11-03 22:02: CF3ZG0 was spawned as `pi --model ...` and sat
		// untold for 44 minutes, its spec dropped.
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: "pi --model anthropic/claude-opus-5-5:high",
			note: "Audit the checks.",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(opened).toBeUndefined();
		const given = handed() as { sessions: Record<string, unknown>[] };
		expect(given.sessions[0]).toMatchObject({
			fresh: true,
			model: "anthropic/claude-opus-5-5:high",
		});
		const words = wordsFor(given.sessions[0]?.id as string);
		expect(words).toContain(`Carry on with ${id}`);
		expect(words).toContain("Audit the checks.");
	});

	it("tells a pi the caller names its own way to carry on too, when it opens it itself", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: "pi --model anthropic/claude-opus-5-5:high",
			note: "Audit the checks.",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(opened).toBe("pi --model anthropic/claude-opus-5-5:high");
		const token = openedEnv?.[FIRST_WORDS_VARIABLE] as string;
		expect(wordsFor(token)).toContain(`Carry on with ${id}`);
		expect(wordsFor(token)).toContain("Audit the checks.");
		expect(result.details).toMatchObject({ firstWordsKey: token });
	});

	it("tells a pi started behind a holder to carry on too", async () => {
		// 11-07 17:48 and 17:50: 95E131 and NZLJZ4 were spawned as
		// `mycelium --realm work hold -- pi --model ...`, and neither was
		// told its note, since only a command starting with pi counted.
		const { state, id } = await quest();
		const command =
			"mycelium --realm work hold -- pi --model anthropic/claude-opus-5-5:high";
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command,
			note: "Audit what slipped.",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(opened).toBe(command);
		const token = openedEnv?.[FIRST_WORDS_VARIABLE] as string;
		expect(wordsFor(token)).toContain("Audit what slipped.");
		expect(result.details).toMatchObject({ firstWordsKey: token });
		expect(result.message).toContain(`will load ${id}`);
	});

	describe("in a folder pi asks to trust", () => {
		// 11-07 20:20: three of six spawns sat at pi's folder-trust prompt in
		// agent-cut trees until their orchestrator answered it by hand.
		const untrusted = () => {
			const agentDir = join(tmpRoot, "agent");
			mkdirSync(agentDir, { recursive: true });
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const cwd = join(tmpRoot, "tree");
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");
			return { agentDir, cwd };
		};

		it("says the prompt will wait before the note is read", async () => {
			const { state, id } = await quest();
			const { cwd } = untrusted();
			const result = await handle(
				state,
				fakePi(),
				fakeCtx(tmpRoot, "spawner"),
				{ action: "spawn", id, cwd, note: "Carry on." },
			);
			if (!result.ok) throw new Error(result.guidance);
			expect(result.message).toContain(
				`Nothing has trusted ${cwd}, so its pi stops at pi's folder-trust prompt`,
			);
			expect(result.details).toMatchObject({ trustWaits: cwd });
		});

		it("says nothing once the folder's trust is saved", async () => {
			const { state, id } = await quest();
			const { agentDir, cwd } = untrusted();
			writeFileSync(
				join(agentDir, "trust.json"),
				// Saved under its canonical path, as pi saves it.
				JSON.stringify({ [realpathSync(cwd)]: true }),
			);
			const result = await handle(
				state,
				fakePi(),
				fakeCtx(tmpRoot, "spawner"),
				{ action: "spawn", id, cwd },
			);
			if (!result.ok) throw new Error(result.guidance);
			expect(result.message).not.toContain("folder-trust");
			expect(result.details).not.toHaveProperty("trustWaits");
		});
	});

	it("leaves a command that only mentions pi after its own separator alone", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: "git log -- pi",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(openedEnv?.[FIRST_WORDS_VARIABLE]).toBeUndefined();
	});

	it("hands a restart to the launcher, in its own place and on the model it names", async () => {
		// 11-07 00:37: orchestrators restart sessions under a new holder as
		// `pi --session <id> --model ...`, which opened kitty on whatever
		// workspace was focused, never through the launcher's placing.
		const { state, id } = await quest();
		const back = "01a1b496-049b-7607-91e1-3d9c8adb7edc";
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: `pi --session ${back} --model anthropic/claude-opus-5-5:high`,
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: Record<string, unknown>[] };
		expect(given.sessions).toEqual([
			{
				id: back,
				cwd: tmpRoot,
				quest: id,
				from: "spawner",
				// Nothing orchestrates Alpha, so it says its title, and its
				// window opens on its own quest's workspace.
				title: "Alpha",
				workspace: questAddress(id),
				replaces: back,
				model: "anthropic/claude-opus-5-5:high",
				focus: false,
			},
		]);
		expect(opened).toBeUndefined();
	});

	it("opens a resume that asks for more than a model itself", async () => {
		const { state, id } = await quest();
		const command =
			"pi --session 01a1b496-049b-7607-91e1-3d9c8adb7edc --no-extensions";
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeUndefined();
		expect(opened).toBe(command);
	});

	it("leaves no words for a command of the caller's own", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: "htop",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(opened).toBe("htop");
		expect(openedEnv?.[FIRST_WORDS_VARIABLE]).toBeUndefined();
		expect(
			existsSync(firstWordsDir()),
			`${firstWordsDir()} is never made`,
		).toBe(false);
	});

	it("opens the window itself when the launcher refuses", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeDefined();
		expect(opened).toBe("pi");
		expect(result.message).toContain("Spawned a window");
		expect(started()).toBeUndefined();
	});

	// 11-10 13:28: two spawns the launcher didn't take opened plain kitty
	// windows outside the desktop's sessions kitty (Y2YBTS [9f93dcd0]).
	it("opens the window in the desktop's sessions kitty when the launcher refuses and that kitty runs", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		process.env.PI_SESSIONS_KITTY = "on";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeDefined();
		expect(opened).toBeUndefined();
		const words = started() ?? [];
		const windowClass = words[6] ?? "";
		expect(words.slice(0, 11)).toEqual([
			"@",
			"--to",
			`unix:${join(tmpRoot, "run", "pi-sessions", "kitty.sock")}`,
			"launch",
			"--type=os-window",
			"--os-window-class",
			windowClass,
			"--cwd",
			tmpRoot,
			"--env",
			`MYCELIUM_APP_ID=${windowClass}`,
		]);
		expect(
			windowClass,
			"a class of its own, which niri opens unfocused",
		).toMatch(/^pi-spawned\.[0-9]+$/);
		expect(result.message).toContain(
			"Spawned a window in the desktop's sessions kitty",
		);
		expect(result.details).toMatchObject({ how: "sessions-kitty" });
	});

	it("hands the session to the launcher while the screen is locked", async () => {
		// The shell starts it behind the lock and places it once the lock
		// is gone (core.nix #1632), where a window opened here would sit
		// wherever the terminal put it.
		process.env.QS_LOCKED = "true";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeDefined();
		expect(opened).toBeUndefined();
	});

	it("leaves a layout the call names to the terminal", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn-tab",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeUndefined();
		expect(opened).toBe("pi");
	});

	it("asks nothing on a dry run, saying the launcher goes first", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			dryRun: true,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeUndefined();
		expect(opened).toBeUndefined();
		expect(result.message).toContain("it goes first to the desktop's launcher");
		expect(
			existsSync(firstWordsDir()),
			`${firstWordsDir()} is never made`,
		).toBe(false);
	});
});
