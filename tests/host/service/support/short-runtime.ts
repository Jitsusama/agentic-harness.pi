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

/** A conversation's id, the longest name a child's slot takes. */
const LONGEST_SLOT = "00000000-0000-4000-8000-000000000000";

/**
 * A fresh runtime folder whose children of the host keyed `key` fit:
 * under the run's temp folder when they fit there, as under Linux's
 * /tmp, so a fenced run that may write only there still can, and the
 * run's teardown takes it if the case can't. Otherwise under /tmp, which
 * is short on every machine the tests run on. The caller removes it.
 */
export async function shortRuntime(key: string): Promise<string> {
	const near = await mkdtemp(join(tmpdir(), "rt-"));
	if (childrenFit(near, key)) return near;
	await rm(near, { recursive: true, force: true });
	return mkdtemp(join("/tmp", "rt-"));
}

/** Whether every child's socket the host keyed `key` makes in `runtime` fits. */
function childrenFit(runtime: string, key: string): boolean {
	const socket = join(slotFolder(runtime, key), `${LONGEST_SLOT}.sock`);
	return Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES;
}
