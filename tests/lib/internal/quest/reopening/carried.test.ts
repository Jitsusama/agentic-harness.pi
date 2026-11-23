import {
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
import { afterEach, describe, expect, it } from "vitest";
import {
	carriedSessions,
	placeCarried,
	placeTakenOver,
	sessionFolderOf,
	takeUpCarried,
	writePlaced,
} from "../../../../../lib/internal/quest/reopening/carried.ts";

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

describe("a session's file placed a chunk at a time", () => {
	const header = (cwd: string) =>
		JSON.stringify({ type: "session", id: "01a19111-sbx1", cwd, pad: "ü" });

	/** The copy of `text` placed for `/home/joel` reading `chunk` bytes at a time. */
	function placed(text: string | Buffer, chunk: number): Buffer {
		const from = join(folder(), FILE);
		const to = join(folder(), "--home-joel--", FILE);
		writeFileSync(from, text);
		writePlaced(from, to, "/home/joel", chunk);
		return readFileSync(to);
	}

	it("rewrites a header split across chunks, and copies lines split across them as they were", () => {
		const lines = Array.from({ length: 500 }, (_, at) =>
			JSON.stringify({ type: "message", at, says: "naïve ✓".repeat(at % 5) }),
		);
		const text = `${header("/Users/joel")}\n${lines.join("\n")}\n`;

		// Chunks of 7 and 13 bytes split the header, the newline after it,
		// many lines and many of their two- and three-byte characters.
		for (const chunk of [1, 7, 13, 4096]) {
			expect(
				placed(text, chunk).toString("utf8"),
				`${chunk} bytes a read`,
			).toBe(`${header("/home/joel")}\n${lines.join("\n")}\n`);
		}
	});

	it("copies every byte after the header as it stands, even one that isn't text", () => {
		const after = Buffer.from([0x0a, 0xff, 0xfe, 0x0a, 0xc3, 0x0a]);
		const text = Buffer.concat([Buffer.from(header("/Users/joel")), after]);

		expect(placed(text, 5)).toEqual(
			Buffer.concat([Buffer.from(header("/home/joel")), after]),
		);
	});

	it("ends a file of only a header, with no newline, with one", () => {
		expect(placed(header("/Users/joel"), 3).toString("utf8")).toBe(
			`${header("/home/joel")}\n`,
		);
	});

	it("writes nothing from a file whose first line is no header, or never ends", () => {
		const from = join(folder(), FILE);
		const to = join(folder(), "--home-joel--", FILE);

		writeFileSync(from, '{"type":"sess\n{}\n');
		expect(() => writePlaced(from, to, "/home/joel", 4)).toThrow(SyntaxError);
		writeFileSync(from, "x".repeat(70 * 1024));
		expect(() => writePlaced(from, to, "/home/joel", 4096)).toThrow(
			"its first line passes 64 KiB",
		);
		expect(existsSync(to), "nothing placed").toBe(false);
	});
});

describe("a session taken over from another machine", () => {
	it("is placed for its folder here, over a copy from an earlier visit", () => {
		const store = folder();
		const carried = join(folder(), FILE);
		writeFileSync(carried, sessionText("01a19111-sbx1", "/Users/joel/src/app"));
		const earlier = join(sessionFolderOf(store, "/home/joel/src/app"), FILE);
		mkdirSync(join(earlier, ".."), { recursive: true });
		writeFileSync(earlier, "what it was before it left\n");

		const path = placeTakenOver(
			"01a19111-sbx1",
			carried,
			"/home/joel/src/app",
			store,
		);

		expect(path).toBe(earlier);
		const [header, turn] = readFileSync(earlier, "utf8").split("\n");
		expect(JSON.parse(header ?? "").cwd).toBe("/home/joel/src/app");
		expect(turn).toContain('"content":"hi"');
	});

	it("is placed whole from a log of more lines than one read takes, only its header changed", () => {
		const store = folder();
		const carried = join(folder(), FILE);
		const turns = Array.from({ length: 40_000 }, (_, at) =>
			JSON.stringify({ type: "message", at, content: "é".repeat(at % 7) }),
		).join("\n");
		writeFileSync(
			carried,
			`${sessionText("01a19111-sbx1", "/Users/joel/src/app")}${turns}\n`,
		);

		const path = placeTakenOver(
			"01a19111-sbx1",
			carried,
			"/home/joel/src/app",
			store,
		);

		const [was, ...wasRest] = readFileSync(carried, "utf8").split("\n");
		const [header, ...rest] = readFileSync(path ?? "", "utf8").split("\n");
		expect(JSON.parse(header ?? "")).toEqual({
			...JSON.parse(was ?? ""),
			cwd: "/home/joel/src/app",
		});
		expect(rest, "every line after the header as it was").toEqual(wasRest);
		expect(rest).toHaveLength(40_002);
	});

	it("is never placed from a file that names another session", () => {
		const carried = join(folder(), FILE);
		writeFileSync(carried, sessionText("someone-else", "/Users/joel"));

		expect(
			placeTakenOver("01a19111-sbx1", carried, "/home/joel", folder()),
		).toBeUndefined();
	});
});
