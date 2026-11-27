/**
 * A sealed home for a host under test: its own HOME, XDG folders and
 * TMPDIR in one private folder, so the host, its engine and every
 * conversation's harness read and write nothing of the person's. Only
 * PATH comes from outside, so node and git are found. SHELL is always
 * /bin/sh, never the caller's: script(1) runs the account's passwd shell
 * without one, which for a Nix build user is /noshell, so a terminal pi
 * never starts, and with the caller's a terminal would differ from one
 * account to the next.
 *
 * The folder is kept short: a host's socket, and each of its children's
 * slot sockets, live under XDG_RUNTIME_DIR, and a Unix socket's path
 * can't pass 103 bytes on a Mac. Where the longest child socket wouldn't
 * fit under the run's temp folder, as under a quest session's TMPDIR or
 * a Mac's own, the seal goes under the run's short folder in /tmp.
 *
 * Everything is reached through a link to the folder, as a loaded quest's
 * TMPDIR is on Joel's machine: a link into the quest's scratch folder.
 * pi names a folder by its real path, so a case comparing a path it made
 * with one pi named fails on every machine, not only on his (14 November:
 * three cases failed there and passed on the lenders).
 *
 * Each seal serves a realm of its own. A host's key is its realm and kind,
 * and a host starting reaps what a dead host under its key left running,
 * so seals sharing a realm could end each other's tool children.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hostKey,
	MAX_SOCKET_PATH_BYTES,
} from "../../../../host/service/address.ts";
import { slotFolder } from "../../../../host/service/child-units.ts";
import { SOCKET_ROOT } from "../../../setup/temp-root.ts";

/** A conversation's id, the longest name a child's slot takes. */
const LONGEST_SLOT = "00000000-0000-4000-8000-000000000000";

/** What mkdtemp adds to a seal's folder name: its prefix and six letters. */
const SEAL_FOLDER = "e-XXXXXX";

/** How many hex digits name a seal's realm after its prefix. */
const REALM_BYTES = 3;

/**
 * How often, and how far apart, a seal's removal tries again on a folder
 * still being written. A subagent a killed host started can still be
 * writing node's compile cache under the seal's state as it goes: E7
 * failed in teardown with ENOTEMPTY on 23 November, its assertions
 * passed (3PXQTB's aed7c132, ISXEG8's cac115dd).
 */
const REMOVE_RETRIES = 10;
const REMOVE_RETRY_MS = 200;

/** What a seal's link adds to the name of the folder it reaches, kept to one byte for the socket's sake. */
const LINK_SUFFIX = "l";

/** Each sealed variable and the folder under the seal it names. */
const SEALED_FOLDERS = {
	HOME: "h",
	XDG_CONFIG_HOME: "c",
	XDG_DATA_HOME: "d",
	XDG_STATE_HOME: "s",
	XDG_CACHE_HOME: "k",
	XDG_RUNTIME_DIR: "r",
	TMPDIR: "t",
} as const;

/** A sealed home, and how to take it away. */
export interface Seal {
	/** The private folder everything sealed lives under, as the link reaching it. */
	readonly root: string;
	/** The folder itself, as pi names it: a path pi made reads under this, not `root`. */
	readonly real: string;
	/** The host's HOME. */
	readonly home: string;
	/** The realm this seal's host and node serve, and no other seal's. */
	readonly realm: string;
	/** The whole environment a sealed host runs with. */
	readonly env: NodeJS.ProcessEnv;
	/** Remove the seal and everything in it. */
	dispose(): Promise<void>;
}

/**
 * The socket path of the longest child a host sealed under `parent`
 * would make: its slot folder under the seal's XDG_RUNTIME_DIR, named
 * by a conversation's id. The host's own socket is shorter.
 */
export function longestChildSocket(parent: string, realm: string): string {
	const runtime = join(
		`${join(parent, SEAL_FOLDER)}${LINK_SUFFIX}`,
		SEALED_FOLDERS.XDG_RUNTIME_DIR,
	);
	return join(
		slotFolder(runtime, hostKey(realm, "background")),
		`${LONGEST_SLOT}.sock`,
	);
}

/**
 * The folder a seal goes in: the run's temp folder when every socket fits
 * there, else the run's short folder, else none.
 */
export function sealParent(
	realm: string,
	near: string,
	short: string | undefined,
): string | undefined {
	for (const parent of [near, short]) {
		if (parent === undefined) continue;
		const socket = longestChildSocket(parent, realm);
		if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return parent;
	}
	return undefined;
}

/** Make a sealed home, refusing one whose children's sockets would be too long. */
export async function seal(): Promise<Seal> {
	const realm = `sealed-${randomBytes(REALM_BYTES).toString("hex")}`;
	const parent = sealParent(realm, tmpdir(), process.env[SOCKET_ROOT]);
	if (parent === undefined)
		throw new Error(
			`A sealed host's child socket would be ${longestChildSocket(tmpdir(), realm)}, past ${MAX_SOCKET_PATH_BYTES} bytes: run with a shorter TMPDIR`,
		);
	const real = await mkdtemp(join(parent, "e-"));
	const root = `${real}${LINK_SUFFIX}`;
	await symlink(real, root);
	const dispose = async () => {
		await rm(real, {
			recursive: true,
			force: true,
			maxRetries: REMOVE_RETRIES,
			retryDelay: REMOVE_RETRY_MS,
		});
		await rm(root, { force: true });
	};
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		SHELL: "/bin/sh",
		LANG: "C.UTF-8",
		MYCELIUM_REALM: realm,
	};
	for (const [name, folder] of Object.entries(SEALED_FOLDERS)) {
		const path = join(root, folder);
		await mkdir(path, { mode: 0o700 });
		env[name] = path;
	}
	return {
		root,
		// Resolved whole: TMPDIR may itself be a link, as a loaded quest's is.
		real: await realpath(real),
		home: join(root, SEALED_FOLDERS.HOME),
		realm,
		env,
		dispose,
	};
}
