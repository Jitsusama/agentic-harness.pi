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
 * The folder is kept short: a host's socket lives under XDG_RUNTIME_DIR,
 * and a Unix socket's path can't pass 107 bytes.
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
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSocketPath } from "../../../../host/service/address.ts";

/** The longest path a Unix socket takes, less its closing zero. */
const SOCKET_PATH_LIMIT = 107;

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
	/** The host's HOME. */
	readonly home: string;
	/** The realm this seal's host and node serve, and no other seal's. */
	readonly realm: string;
	/** The whole environment a sealed host runs with. */
	readonly env: NodeJS.ProcessEnv;
	/** Remove the seal and everything in it. */
	dispose(): Promise<void>;
}

/** Make a sealed home, refusing one whose host socket would be too long. */
export async function seal(): Promise<Seal> {
	const real = await mkdtemp(join(tmpdir(), "e-"));
	const root = `${real}${LINK_SUFFIX}`;
	await symlink(real, root);
	const dispose = async () => {
		await rm(real, { recursive: true, force: true });
		await rm(root, { force: true });
	};
	const realm = `sealed-${randomBytes(3).toString("hex")}`;
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
	const socket = hostSocketPath(realm, "background", env.XDG_RUNTIME_DIR);
	if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
		await dispose();
		throw new Error(
			`A sealed host's socket would be ${socket}, past ${SOCKET_PATH_LIMIT} bytes: run with a shorter TMPDIR`,
		);
	}
	return {
		root,
		home: join(root, SEALED_FOLDERS.HOME),
		realm,
		env,
		dispose,
	};
}
