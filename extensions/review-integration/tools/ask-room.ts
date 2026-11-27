/**
 * The room a round's reviewers run on, when the package config names
 * one: `sections.review.room`, `{ "machine": "<room>", "realm": "work" }`.
 *
 * Only a change on one of the repositories a room keeps a checkout of
 * goes there, and only with its head commit known, since the room's
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
import type { RoomAsk } from "../../../lib/subagent/run-contract.ts";
import { ROOM_REPOS } from "../../../lib/subagent/runpi/room-launch.ts";
import { REVIEW_SLUG } from "../config.ts";
import { fencePacks } from "./ask-reviewer.ts";

/** Who keeps the repositories a room keeps a checkout of, on GitHub. */
const ROOM_OWNER = "github:Jitsusama/";

/** The realm a room is in, when the config names none. */
const DEFAULT_REALM = "work";

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

/** Where this package's code lies, and what the room's entry loads itself. */
export interface RoomHarness {
	readonly root: string;
	readonly entryLoads: readonly string[];
}

/**
 * This package's code, as a reviewer reading `folder` loads it: the
 * fence's extensions are the ones the room's entry loads itself.
 */
export function roomHarness(folder: string): RoomHarness {
	return { root: packageRoot(), entryLoads: fencePacks(folder) };
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
	const repo = roomRepo(change.repo.key);
	if (repo === undefined || head === undefined) return undefined;
	const named = await roomNamed(path);
	if (named === undefined) return undefined;
	const command = mycelium();
	if (command === undefined) return undefined;
	const harness = harnessHere(harnessOf);
	if (harness === undefined) return undefined;
	return {
		place: {
			mycelium: command,
			realm: named.realm,
			machine: named.machine,
			harnessRoot: harness.root,
			entryLoads: harness.entryLoads,
		},
		code: { repo, commit: head },
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

/** The room's name for a repository it keeps, or nothing. */
function roomRepo(key: string): string | undefined {
	if (!key.startsWith(ROOM_OWNER)) return undefined;
	const name = key.slice(ROOM_OWNER.length);
	return ROOM_REPOS.has(name) ? name : undefined;
}

/** The room the config names, or nothing when it names none or misnames one. */
async function roomNamed(
	path: string,
): Promise<{ machine: string; realm: string } | undefined> {
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) return undefined;
	const review = loaded.config.sections[REVIEW_SLUG];
	const room = isRecord(review) ? review.room : undefined;
	if (!isRecord(room)) return undefined;
	const { machine, realm } = room;
	if (typeof machine !== "string" || machine === "") return undefined;
	return {
		machine,
		realm: typeof realm === "string" && realm !== "" ? realm : DEFAULT_REALM,
	};
}
