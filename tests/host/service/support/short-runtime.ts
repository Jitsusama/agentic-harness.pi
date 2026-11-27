/**
 * A runtime folder a host's children fit in, for a test whose host is
 * meant to set its children up. A real runtime folder is short
 * (/run/user/<uid>), but a test's sits under the run's temp folder,
 * which a session may have set long enough that a child's socket would
 * pass a Unix address's limit, and the host would then run without
 * children and report it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../../../../host/service/address.ts";
import { slotFolder } from "../../../../host/service/child-units.ts";
import { SOCKET_ROOT } from "../../../setup/temp-root.ts";

/** A conversation's id, the longest name a child's slot takes. */
const LONGEST_SLOT = "00000000-0000-4000-8000-000000000000";

/**
 * A fresh runtime folder the children of the host keyed `key` fit in.
 * It goes under the run's temp folder when they fit there, which holds
 * only for a run folder of 25 bytes or less, so a session's TMPDIR of 7
 * or less, as /tmp is, since the run's own folder adds 18. Everywhere
 * else, every quest session's TMPDIR included, it goes under the run's
 * short folder in /tmp. The run's teardown removes either, even after a
 * killed worker. With no short folder, as where /tmp may not be written,
 * it stays under the run's temp folder: the host there runs without
 * children and says why, so only a test needing them fails. The caller
 * removes it.
 */
export async function shortRuntime(key: string): Promise<string> {
	const near = await mkdtemp(join(tmpdir(), "rt-"));
	const sockets = process.env[SOCKET_ROOT];
	if (sockets === undefined || childrenFit(near, key)) return near;
	await rm(near, { recursive: true, force: true });
	return mkdtemp(join(sockets, "rt-"));
}

/** Whether every child's socket the host keyed `key` makes in `runtime` fits. */
function childrenFit(runtime: string, key: string): boolean {
	const socket = join(slotFolder(runtime, key), `${LONGEST_SLOT}.sock`);
	return Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES;
}
