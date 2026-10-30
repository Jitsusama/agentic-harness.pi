import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	carriedSessions,
	placeCarried,
	sessionFolderOf,
	takeUpCarried,
} from "../../../../lib/internal/quest/carried.ts";

const QUEST = "QEST-20261025-85PKB2";
const FILE = "2026-10-30T22-00-00-000Z_01a19111-sbx1.jsonl";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "carried-")));
	dirs.push(dir);
	return dir;
}

/** A session file as pi writes it: a header, then its turns. */
function sessionText(id: string, cwd: string): string {
	return [
		JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "t" }),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: "hi" },
		}),
		"",
	].join("\n");
}

/** What `work`'s carry leaves on `machine` for one session; `null` leaves out its file. */
function carry(
	workspaces: string,
	machine: string,
	note: Record<string, unknown>,
	text: string | null = sessionText("01a19111-sbx1", "/sandbox/src/harness"),
): string {
	const sessions = join(workspaces, QUEST, "handover", machine, "sessions");
	mkdirSync(sessions, { recursive: true });
	if (text !== null) writeFileSync(join(sessions, FILE), text);
	writeFileSync(
		join(sessions, `${String(note.id)}.json`),
		JSON.stringify(note),
	);
	return sessions;
}

const NOTE = {
	id: "01a19111-sbx1",
	cwd: "/sandbox/src/harness",
	quest: QUEST,
	title: "Harness",
	file: FILE,
};

describe("sessions carried home", () => {
	it("finds what other machines carried, never what this one did", () => {
		const workspaces = folder();
		const sessions = carry(workspaces, "sandbox-7", NOTE);
		carry(workspaces, "optimus", { ...NOTE, id: "01a19222-mine" });

		expect(carriedSessions(workspaces, "optimus")).toEqual([
			{
				id: "01a19111-sbx1",
				quest: QUEST,
				title: "Harness",
				from: "sandbox-7",
				at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				file: join(sessions, FILE),
			},
		]);
	});

	it("leaves out a note whose file is missing, names another session, or isn't safe", () => {
		const workspaces = folder();
		carry(workspaces, "gone", NOTE, null);
		carry(workspaces, "other", NOTE, sessionText("01a19999-else", "/x"));
		carry(workspaces, "unsafe", { ...NOTE, file: "../../escape.jsonl" });
		carry(workspaces, "torn", NOTE, '{"type":"sess');

		expect(carriedSessions(workspaces, "optimus")).toEqual([]);
	});

	it("places a copy that pi finds in its home folder and opens there", () => {
		const workspaces = folder();
		const store = folder();
		carry(workspaces, "sandbox-7", NOTE);
		const [carried] = carriedSessions(workspaces, "optimus");
		if (carried === undefined) throw new Error("nothing was carried");

		const placed = placeCarried(
			carried,
			"/home/me/src/harness",
			store,
			new Map(),
		);

		const path = join(sessionFolderOf(store, "/home/me/src/harness"), FILE);
		expect(placed).toEqual({ kind: "placed", path });
		expect(path, "pi's own name for the folder").toContain(
			"--home-me-src-harness--",
		);
		const [header, turn] = readFileSync(path, "utf8").split("\n");
		expect(JSON.parse(header ?? "")).toMatchObject({
			id: "01a19111-sbx1",
			cwd: "/home/me/src/harness",
		});
		expect(JSON.parse(turn ?? "")).toMatchObject({ type: "message" });
	});

	it("never places over a session this machine already has", () => {
		const workspaces = folder();
		const store = folder();
		carry(workspaces, "sandbox-7", NOTE);
		const [carried] = carriedSessions(workspaces, "optimus");
		if (carried === undefined) throw new Error("nothing was carried");
		const mine = join(store, "--elsewhere--", FILE);
		mkdirSync(join(store, "--elsewhere--"));
		writeFileSync(mine, "mine\n");

		expect(
			placeCarried(
				carried,
				"/home/me/src/harness",
				store,
				new Map([[carried.id, mine]]),
			),
		).toEqual({ kind: "already", path: mine });
		expect(readFileSync(mine, "utf8")).toBe("mine\n");
	});

	it("offers each for its quest's newest tree here, as spawn would open it", () => {
		const workspaces = folder();
		const store = folder();
		const quests = folder();
		const tree = folder();
		carry(workspaces, "sandbox-7", NOTE);
		mkdirSync(join(quests, QUEST));
		writeFileSync(
			join(quests, QUEST, "README.md"),
			[
				"---",
				`id: ${QUEST}`,
				"kind: quest",
				"status: active",
				"priority: active",
				"rank: 1",
				"started: 2026-10-25",
				"updated: 2026-10-30",
				"trees:",
				`  - path: ${tree}`,
				"    providerId: git-worktree",
				"---",
				"",
				"# The Harness",
				"",
			].join("\n"),
		);

		const offered = takeUpCarried({
			workspaces,
			here: "optimus",
			sessions: store,
			known: new Map(),
			quests,
			home: "/home/me",
		});

		expect(offered).toEqual([
			expect.objectContaining({
				id: "01a19111-sbx1",
				title: "Harness",
				cwd: tree,
				carried: { from: "sandbox-7", at: expect.any(String) },
			}),
		]);
		expect(
			JSON.parse(
				readFileSync(join(sessionFolderOf(store, tree), FILE), "utf8").split(
					"\n",
				)[0] ?? "",
			).cwd,
		).toBe(tree);
	});
});
