/**
 * What the node's command starts with when it is asked about a room:
 * the supervisor's `run` of a reviewer there, and the asking session's
 * `place` of one through the node. Both run it unfenced, as the person.
 */

import { userInfo } from "node:os";
import { dirname } from "node:path";

/**
 * The variables the node's own command reads, the only ones it gets: a
 * reviewer's own, its gateway key among them, stay here, since a room's
 * outer run can be read by other runs there.
 */
const ROOM_ENV: ReadonlySet<string> = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TERM",
	"XDG_RUNTIME_DIR",
]);

/**
 * The environment the node's command starts with: only what it reads,
 * with PATH cut to the folder that command was found in and the
 * system's profile folders. The reviewer's PATH holds folders a fenced
 * command may write, such as a tree's `.direnv/bin`, and this command
 * runs unfenced.
 */
export function roomEnv(
	env: NodeJS.ProcessEnv,
	binary: string,
): NodeJS.ProcessEnv {
	const path = [
		dirname(binary),
		`/etc/profiles/per-user/${userInfo().username}/bin`,
		"/run/current-system/sw/bin",
	].join(":");
	const kept: NodeJS.ProcessEnv = { PATH: path };
	for (const [name, value] of Object.entries(env)) {
		if (ROOM_ENV.has(name) || name.startsWith("MYCELIUM_")) kept[name] = value;
	}
	return kept;
}
