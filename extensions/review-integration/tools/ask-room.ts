/**
 * The room a round's reviewers run on, when the package config names
 * one: `sections.review.rooms`, keyed by the change's repository key,
 * each `{ "repo": "world", "realm"?, "machine"?, "needs"? }`, or else
 * `sections.review.room`, `{ "machine": "<room>", "realm": "work" }`,
 * the default room for the repositories it keeps (ROOM_REPOS).
 *
 * A change goes there only with its head commit known, since the room's
 * entry checks that commit out before its reviewer starts. Anything
 * else, and every round where no room is named, runs here as before.
 * Read once a round, like the round's clocks.
 */

import type { ChangeRef } from "../../../lib/core/review/index.ts";
import { loadPackageConfig } from "../../../lib/internal/config/loader.ts";
import { packageRoot } from "../../../lib/internal/fence/installed-only.ts";
import { packageConfigPath } from "../../../lib/internal/paths.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	systemFolders,
	systemProgram,
} from "../../../lib/internal/sandbox/system-program.ts";
import { getSubagentDefaults } from "../../../lib/subagent/defaults.ts";
import type { RoomAsk } from "../../../lib/subagent/run-contract.ts";
import {
	MAX_ROOM_BRIEF_BYTES,
	ROOM_REPO_NAME,
	ROOM_REPOS,
	type RoomMachine,
} from "../../../lib/subagent/runpi/room-launch.ts";
import { REVIEW_SLUG } from "../config.ts";
import { fencePacks } from "./ask-reviewer.ts";

/** Who keeps the repositories a room keeps a checkout of, on GitHub. */
const ROOM_OWNER = "github:Jitsusama/";

/** The realm a room is in, when the config names none. */
const DEFAULT_REALM = "work";

/** A need as mycelium's `run --need` takes it: `kind=value`, one word. */
const NEED = /^[a-z][a-z0-9_-]*=\S+$/;

/** The node's own command, by name, as every other caller asks it. */
const MYCELIUM = "mycelium";

/**
 * The node's command, found only in the system's profile folders with
 * nothing on the way to it anyone's but root's, or nothing. The
 * supervisor runs it unfenced, as the person, and PATH holds folders a
 * fenced command may write, such as a tree's `.direnv/bin`, where one
 * could plant a `mycelium` of its own.
 */
export function myceliumAt(
	folders: readonly string[] = systemFolders(),
): string | undefined {
	return systemProgram(MYCELIUM, folders);
}

/**
 * Where this package's code lies, what the room's entry loads itself,
 * and what this session's reviewers load only here.
 */
export interface RoomHarness {
	readonly root: string;
	readonly entryLoads: readonly string[];
	readonly hereOnly?: readonly string[];
}

/**
 * This package's code, as a reviewer reading `folder` loads it: the
 * fence's extensions are the ones the room's entry loads itself, and
 * the session's registered defaults are this machine's, which a room
 * has no use for: outside packages register them for the model access
 * and credentials here, and the room's entry brings its own provider.
 */
export function roomHarness(folder: string): RoomHarness {
	const defaults = getSubagentDefaults();
	return {
		root: packageRoot(),
		entryLoads: fencePacks(folder),
		hereOnly: [...defaults.extensions, ...defaults.skills],
	};
}

/**
 * Whether a round's prompt fits the command line that starts a reviewer
 * on a room. One that doesn't keeps its round here, since a reviewer
 * asked on a room never runs here instead.
 */
export function briefFitsARoom(prompt: string): boolean {
	return Buffer.byteLength(prompt) <= MAX_ROOM_BRIEF_BYTES;
}

/**
 * The room this change's reviewers run on, and the code they read
 * there, or nothing when they run here.
 */
export async function roomFor(
	change: ChangeRef,
	head: string | undefined,
	harnessOf: () => RoomHarness,
	path: string = packageConfigPath(),
	mycelium: () => string | undefined = myceliumAt,
): Promise<RoomAsk | undefined> {
	if (head === undefined) return undefined;
	const named = await roomNamed(change.repo.key, path);
	if (named === undefined) return undefined;
	const command = mycelium();
	if (command === undefined) return undefined;
	const harness = harnessHere(harnessOf);
	if (harness === undefined) return undefined;
	return {
		place: {
			mycelium: command,
			realm: named.realm,
			...named.on,
			...(named.keyed ? { keyed: true } : {}),
			harnessRoot: harness.root,
			entryLoads: harness.entryLoads,
			...(harness.hereOnly === undefined ? {} : { hereOnly: harness.hereOnly }),
		},
		code: { repo: named.repo, commit: head },
	};
}

/**
 * The harness a room's reviewers read, or nothing when the fence refuses
 * this round's folder, which the round itself then says as it starts.
 */
function harnessHere(harnessOf: () => RoomHarness): RoomHarness | undefined {
	try {
		return harnessOf();
	} catch {
		// The same refusal is thrown again where each reviewer starts.
		return undefined;
	}
}

/** A room the config names for a repository, as the round asks it. */
interface NamedRoom {
	/** The repository's name as the room lays it under ~/src. */
	readonly repo: string;
	readonly realm: string;
	readonly on: RoomMachine;
	/** Named for this repository in `rooms`, not the default `room`. */
	readonly keyed: boolean;
}

/**
 * The room the config names for the repository `key` names: its own in
 * `rooms`, else the default `room` for a repository that one keeps, else
 * nothing. A misnamed room is taken as none.
 */
async function roomNamed(
	key: string,
	path: string,
): Promise<NamedRoom | undefined> {
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) return undefined;
	const review = loaded.config.sections[REVIEW_SLUG];
	if (!isRecord(review)) return undefined;
	const rooms = isRecord(review.rooms) ? review.rooms : {};
	return keyedRoom(rooms[key]) ?? defaultRoom(review.room, key);
}

/** A room keyed to one repository, or nothing when it is misnamed. */
function keyedRoom(entry: unknown): NamedRoom | undefined {
	if (!isRecord(entry)) return undefined;
	const { repo, machine, needs } = entry;
	if (typeof repo !== "string" || !ROOM_REPO_NAME.test(repo)) return undefined;
	const realm = realmOf(entry.realm);
	if (machine !== undefined) {
		if (typeof machine !== "string" || machine === "") return undefined;
		return { repo, realm, on: { machine }, keyed: true };
	}
	if (!Array.isArray(needs) || needs.length === 0) return undefined;
	const named: string[] = [];
	for (const need of needs) {
		if (typeof need !== "string" || !NEED.test(need)) return undefined;
		named.push(need);
	}
	return { repo, realm, on: { needs: named }, keyed: true };
}

/**
 * The default room, for a repository it keeps, or nothing when it keeps
 * none of that name or is misnamed.
 */
function defaultRoom(room: unknown, key: string): NamedRoom | undefined {
	if (!key.startsWith(ROOM_OWNER)) return undefined;
	const repo = key.slice(ROOM_OWNER.length);
	if (!ROOM_REPOS.has(repo) || !isRecord(room)) return undefined;
	const { machine } = room;
	if (typeof machine !== "string" || machine === "") return undefined;
	return { repo, realm: realmOf(room.realm), on: { machine }, keyed: false };
}

/** The realm a room names, or the default where it names none. */
function realmOf(realm: unknown): string {
	return typeof realm === "string" && realm !== "" ? realm : DEFAULT_REALM;
}
