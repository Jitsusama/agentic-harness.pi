/**
 * What a room says of its own pressure and free space, asked through
 * the node, and whether that holds a round whose reviewers run there.
 *
 * A waiting round looks about four times a minute, and 73 waited at
 * once on 27 November, so asking the room at every look would be
 * hundreds of node calls a minute for one answer. What the room said
 * is kept a few seconds in one file every round on this machine reads,
 * and asked again only once it is older.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	machineShort,
	ROOM_READINGS_COMMAND,
	roomQuiet,
	roomShort,
} from "../../../lib/core/review/ask/machine-room.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { writeWholeOff } from "../../../lib/internal/write-whole.ts";
import type { RoomPlace } from "../../../lib/subagent/runpi/room-launch.ts";

const run = promisify(execFile);

/** How long what a room said stands before it is asked again. */
export const ROOM_READS_KEPT_MS = 10_000;

/** How long the node may take to bring back what a room said. */
const ROOM_ANSWERS_WITHIN_MS = 20_000;

/**
 * The variables the node's command reads, as the supervisor gives it
 * for a reviewer: the session's PATH holds folders a fenced command may
 * write, and this command runs unfenced.
 */
const ROOM_ENV = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TERM",
	"XDG_RUNTIME_DIR",
]);

/** Where a room is, as its readings are asked. */
export type RoomAt = Pick<RoomPlace, "mycelium" | "realm" | "machine">;

/** What a room's readings say for the start line. */
export interface RoomReadings {
	/** What keeps a round from starting on the room now, or nothing. */
	readonly short: () => Promise<string | undefined>;
	/** Whether the room is quiet enough for the quickest spacing. */
	readonly quiet: () => Promise<boolean>;
}

/** What the readings are read with, put in by a test. */
export interface RoomReadingsDeps {
	/** The folder each room's last answer is kept in. */
	readonly folder?: string;
	readonly now?: () => number;
	/** Asks the room, answering what it printed or nothing. */
	readonly ask?: (room: RoomAt) => Promise<string | undefined>;
	/** This machine's own shortfall, for a room that didn't answer. */
	readonly here?: () => Promise<string | undefined>;
}

/**
 * The room's readings for the start line. A room that doesn't answer
 * judges the round on this machine's bars, since a reviewer the room
 * gives nothing back to runs here; it is never quiet.
 */
export function roomReadings(
	room: RoomAt,
	deps: RoomReadingsDeps = {},
): RoomReadings {
	const file = join(
		deps.folder ?? join(stateDir("review"), "room-reads"),
		`${encodeURIComponent(room.machine)}.json`,
	);
	const now = deps.now ?? Date.now;
	const ask = deps.ask ?? askRoom;
	const said = () => keptOrAsked(file, room, now, ask);
	return {
		short: async () => {
			const printed = await said();
			if (printed !== undefined) return roomShort(printed);
			const here = await (deps.here ?? machineShort)();
			return here === undefined
				? undefined
				: `the room ${room.machine} didn't answer, so its round waits on this machine's bars: ${here}`;
		},
		quiet: async () => {
			const printed = await said();
			return printed !== undefined && roomQuiet(printed);
		},
	};
}

/** One room's last answer, as kept: when it was asked, and what it said. */
interface Kept {
	readonly at: number;
	readonly said?: string;
}

/**
 * What the room said, from the kept answer while it is fresh, or asked
 * again and kept. A room that didn't answer is kept as that too, so a
 * room that is down isn't asked by every round at every look.
 */
async function keptOrAsked(
	file: string,
	room: RoomAt,
	now: () => number,
	ask: (room: RoomAt) => Promise<string | undefined>,
): Promise<string | undefined> {
	const kept = await readKept(file);
	const age = kept === undefined ? undefined : now() - kept.at;
	// An answer stamped ahead of now, from a clock set back, is asked again.
	if (age !== undefined && age >= 0 && age < ROOM_READS_KEPT_MS) {
		return kept?.said;
	}
	const said = await ask(room);
	const fresh: Kept = { at: now(), ...(said === undefined ? {} : { said }) };
	try {
		await writeWholeOff(file, JSON.stringify(fresh));
	} catch {
		// Unkept, the next look asks the room again: slower, never wrong.
	}
	return said;
}

/** The kept answer, or nothing where none is kept or it can't be read. */
async function readKept(file: string): Promise<Kept | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!isRecord(parsed) || typeof parsed.at !== "number") return undefined;
		return typeof parsed.said === "string"
			? { at: parsed.at, said: parsed.said }
			: { at: parsed.at };
	} catch {
		// None kept yet, or caught mid-write elsewhere: the room is asked.
		return undefined;
	}
}

/** What the room printed for its readings, or nothing when it didn't answer. */
async function askRoom(room: RoomAt): Promise<string | undefined> {
	try {
		const { stdout } = await run(
			room.mycelium,
			[
				`--realm=${room.realm}`,
				"run",
				"--need",
				`machine=${room.machine}`,
				"--",
				...ROOM_READINGS_COMMAND,
			],
			{
				env: nodeEnv(room.mycelium),
				timeout: ROOM_ANSWERS_WITHIN_MS,
				maxBuffer: 1024 * 1024,
			},
		);
		return stdout;
	} catch {
		// Down, gone or slow: said as a room that didn't answer.
		return undefined;
	}
}

/**
 * The environment the node's command starts with, as the supervisor's:
 * only what it reads, with PATH cut to its own folder and the system's
 * profile folders.
 */
function nodeEnv(binary: string): NodeJS.ProcessEnv {
	const kept: NodeJS.ProcessEnv = {
		PATH: [
			dirname(binary),
			`/etc/profiles/per-user/${userInfo().username}/bin`,
			"/run/current-system/sw/bin",
		].join(":"),
	};
	for (const [name, value] of Object.entries(process.env)) {
		if (ROOM_ENV.has(name) || name.startsWith("MYCELIUM_")) kept[name] = value;
	}
	return kept;
}
