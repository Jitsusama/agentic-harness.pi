/**
 * A held session's first prompt makes its quest, marked as its own, and
 * the session's end for good retires that quest only while it is left
 * exactly as it was made.
 */

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStartup } from "../../../../extensions/quest-workflow/lifecycle.ts";
import {
	clearIfLeftAsMade,
	endsForGood,
	type FirstPrompt,
	FORAGE_KEY,
	type ForageGround,
	forageQuest,
	leftAsMade,
	makesQuest,
	typedBefore,
	whyKept,
} from "../../../../extensions/quest-workflow/sessions/first-prompt.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { create } from "../../../../extensions/quest-workflow/verbs/lifecycle.ts";
import { sealLoadedQuest } from "../../../../extensions/quest-workflow/verbs/seal.ts";
import {
	defaultWorkspaceRoot,
	workspaceDirOf,
} from "../../../../extensions/quest-workflow/workspace.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { mutateQuestFrontMatter } from "../../../../lib/internal/quest/fields/mutate.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

const SESSION = "sess-1";
const WORDS =
	"Find out why the nightly backup skipped Tuesday\n\nIt said nothing in the log.";

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};
const envGuard = createEnvGuard();

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "first-prompt-"));
	for (const key of ["HOME", "XDG_CACHE_HOME"]) saved[key] = process.env[key];
	process.env.HOME = tmpRoot;
	process.env.XDG_CACHE_HOME = join(tmpRoot, "cache");
});
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
	clearDiscoveryCache();
});

/** A fresh session's context, with no history to restore. */
function ctxOf(sessionId = SESSION) {
	return {
		cwd: tmpRoot,
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof resolveStartup>[2];
}

/**
 * Session `session`, starting with no quest, making one from `words`.
 * A session that made one before is restored onto it at its start, so
 * each case starts a session of its own.
 */
async function foraged(session = SESSION, words = WORDS) {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const pi = fakePi();
	const ctx = ctxOf(session);
	resolveStartup(state, pi, ctx);
	if (state.questId) throw new Error(`${session} started on ${state.questId}`);
	const id = await forageQuest(state, session, words, (params) =>
		create(state, pi, ctx, params),
	);
	if (!id || state.questId !== id || !state.questDir)
		throw new Error(`${session} isn't on the quest it made`);
	return { state, id, dir: state.questDir };
}

/** The loaded quest's front matter, read from disk. */
function frontMatterOf(dir: string) {
	const fm = parseQuestFrontMatter(
		readFileSync(join(dir, "README.md"), "utf8"),
	)?.frontMatter;
	if (!fm) throw new Error(`no front matter in ${dir}`);
	return fm;
}

/** Retire as `quest retire` does. */
function retireOf(state: ReturnType<typeof createQuestState>) {
	return (params: Parameters<typeof sealLoadedQuest>[2]) =>
		sealLoadedQuest(state, "retire", params);
}

describe("which prompt makes a quest", () => {
	const typed: FirstPrompt = { text: WORDS, source: "interactive" };
	const held: ForageGround = {
		env: { MYCELIUM_HELD: "1" },
		hasUI: true,
		questLoaded: false,
		sprouted: false,
		typedBefore: false,
		tried: false,
	};

	it("makes one from the first words typed into a held session with no quest", () => {
		expect(
			makesQuest(typed, held),
			"a person's first prompt in a held session makes its quest",
		).toBe(true);
	});

	it("makes none anywhere else", () => {
		const cases: [string, FirstPrompt, ForageGround][] = [
			["a session nothing holds", typed, { ...held, env: {} }],
			["a session with no screen", typed, { ...held, hasUI: false }],
			[
				"a subagent",
				typed,
				{ ...held, env: { MYCELIUM_HELD: "1", SUBAGENT_RUN_ID: "r1" } },
			],
			[
				"a pi off the mesh",
				typed,
				{ ...held, env: { MYCELIUM_HELD: "1", PI_MESH: "off" } },
			],
			["a session on a quest", typed, { ...held, questLoaded: true }],
			["a sprout, which makes its own", typed, { ...held, sprouted: true }],
			["a later prompt", typed, { ...held, typedBefore: true }],
			["a second try", typed, { ...held, tried: true }],
			["words an extension sent", { ...typed, source: "extension" }, held],
			["a command", { ...typed, text: "/quest list" }, held],
			["nothing but spaces", { ...typed, text: "  \n " }, held],
		];
		for (const [what, prompt, ground] of cases) {
			expect(makesQuest(prompt, ground), `${what} makes no quest`).toBe(false);
		}
	});

	it("reads a log as typed into only when it holds the person's message", () => {
		expect(
			typedBefore([
				{ type: "custom_message", customType: "x" },
				{ type: "message", message: { role: "assistant" } },
			]),
			"words the session said itself aren't the person's",
		).toBe(false);
		expect(
			typedBefore([{ type: "message", message: { role: "user" } }]),
			"a message from the person is",
		).toBe(true);
	});
});

describe("the quest a first prompt makes", () => {
	it("is titled by the first line, loaded, and marked as the session's", async () => {
		const { state, id, dir } = await foraged();
		expect(state.questId, "the session is on the quest it made").toBe(id);
		expect(state.questTitle, "the title is the first line typed").toBe(
			"Find out why the nightly backup skipped Tuesday",
		);
		expect(frontMatterOf(dir).kind, "it stands at the top").toBe("quest");
		expect(
			frontMatterOf(dir)._extra?.[FORAGE_KEY],
			"it is marked as this session's",
		).toMatchObject({ session: SESSION });
		expect(
			readFileSync(join(dir, "README.md"), "utf8"),
			"the summary holds what was typed",
		).toContain("It said nothing in the log.");
	});

	it("is retired when its session ends for good having left it as made", async () => {
		const { state, dir } = await foraged();
		expect(whyKept(state, SESSION), "nothing was done in it").toBeUndefined();
		expect(leftAsMade(state, SESSION), "so it reads as left as made").toBe(
			true,
		);
		expect(
			await clearIfLeftAsMade(state, SESSION, retireOf(state)),
			"it is cleared",
		).toBe(true);
		expect(frontMatterOf(dir).status, "retired, which can be undone").toBe(
			"retired",
		);
	});

	// Each a case of its own, so one that stops holding doesn't hide the rest.
	const changes: [string, string, (dir: string, id: string) => void][] = [
		[
			"a journey entry",
			"its journey was written to",
			(dir) => appendFileSync(join(dir, "JOURNEY.md"), "\n- Found it.\n"),
		],
		[
			"its summary edited",
			"its README was changed",
			(dir) => {
				const readme = join(dir, "README.md");
				writeFileSync(
					readme,
					readFileSync(readme, "utf8").replace("Tuesday", "Wednesday"),
				);
			},
		],
		[
			"a document beside it",
			"its folder holds attachments",
			(dir) => {
				mkdirSync(join(dir, "attachments"));
				writeFileSync(join(dir, "attachments", "notes.md"), "notes\n");
			},
		],
		[
			"another session joining",
			"session sess-joining was on it",
			(dir) =>
				mutateQuestFrontMatter(dir, (fm) => ({
					...fm,
					sessions: [
						...fm.sessions,
						{ id: "sess-joining", status: "detached" },
					],
				})),
		],
		[
			"a file in its workspace",
			"its workspace holds a file",
			(_dir, id) => {
				const workspace = workspaceDirOf(defaultWorkspaceRoot(), id);
				if (!workspace) throw new Error(`no workspace for ${id}`);
				mkdirSync(join(workspace, "clone"), { recursive: true });
				writeFileSync(join(workspace, "clone", "data.csv"), "1,2\n");
			},
		],
	];
	for (const [n, [what, why, change]] of changes.entries()) {
		it(`stays after ${what}`, async () => {
			const session = `sess-case-${n}`;
			const { state, id, dir } = await foraged(session);
			change(dir, id);
			expect(whyKept(state, session), `${what} keeps the quest`).toBe(why);
			expect(
				await clearIfLeftAsMade(state, session, retireOf(state)),
				`${what}: nothing is retired`,
			).toBe(false);
			expect(frontMatterOf(dir).status, `${what}: still active`).toBe("active");
		});
	}

	it("stays when its session did more than answer its first prompt", async () => {
		const { state, dir } = await foraged();
		const said = (role: string, content: unknown) => ({
			type: "message",
			message: { role, content },
		});
		const first = said("user", WORDS);
		const answered = said("assistant", [{ type: "text", text: "Looking." }]);
		expect(
			whyKept(state, SESSION, [first, answered]),
			"a first prompt answered in words leaves it as made",
		).toBeUndefined();
		const ranATool = said("assistant", [
			{ type: "toolCall", name: "bash", arguments: {} },
		]);
		const typedAgain = said("user", "And Wednesday?");
		for (const [what, log] of [
			["a tool the agent ran", [first, ranATool]],
			["a second prompt", [first, answered, typedAgain]],
		] as const) {
			expect(whyKept(state, SESSION, log), `${what} keeps the quest`).toBe(
				"its session did more than answer its first prompt",
			);
			expect(
				await clearIfLeftAsMade(state, SESSION, retireOf(state), log),
				`${what}: nothing is retired`,
			).toBe(false);
		}
		expect(frontMatterOf(dir).status, "still active").toBe("active");
	});

	it("stays once a quest is made under it", async () => {
		const { state, id } = await foraged();
		const other = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const made = await create(other, fakePi(), ctxOf("sess-child"), {
			action: "create",
			kind: "subquest",
			title: "Check the Tuesday cron",
			parent: id,
		});
		const child = other.questId;
		if (!child) throw new Error(`no child quest: ${JSON.stringify(made)}`);
		clearDiscoveryCache();
		expect(whyKept(state, SESSION), "a child keeps its parent").toBe(
			`quest ${child} is under it`,
		);
	});

	it("is still cleared beside the quest writer's own files", async () => {
		const { state, dir } = await foraged();
		writeFileSync(join(dir, ".quest.lock"), "");
		mkdirSync(join(dir, ".writing"), { recursive: true });
		expect(
			whyKept(state, SESSION),
			"a lock and the writer's folder aren't work",
		).toBeUndefined();
	});

	it("stays when another session ends, or the quest was never one a prompt made", async () => {
		const { state } = await foraged();
		expect(
			whyKept(state, "sess-other"),
			"only the session that made it clears it",
		).toBe("this session's first prompt didn't make it");
		const plain = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		await create(plain, fakePi(), ctxOf(), {
			action: "create",
			kind: "quest",
			title: "Made by hand",
		});
		expect(
			whyKept(plain, SESSION),
			"a quest made by hand is never cleared",
		).toBe("this session's first prompt didn't make it");
	});
});

describe("which end clears it", () => {
	const quit = {
		reason: "quit",
		parking: false,
		restarting: false,
		signalled: false,
		moving: false,
	};

	it("clears only on a quit its person made", () => {
		expect(endsForGood(quit), "a quit ends it for good").toBe(true);
		for (const [what, end] of [
			["a park", { ...quit, parking: true }],
			["a rollover's restart", { ...quit, restarting: true }],
			["a signal pi reports as a quit", { ...quit, signalled: true }],
			["a move to another holder", { ...quit, moving: true }],
			["a reload", { ...quit, reason: "reload" }],
			["a switch to another session", { ...quit, reason: "new" }],
		] as const) {
			expect(endsForGood(end), `${what} comes back to its quest`).toBe(false);
		}
	});
});
