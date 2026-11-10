/**
 * A sealed home for a host under test: its own HOME, XDG folders and
 * TMPDIR in one private folder, so the host, its engine and every
 * conversation's harness read and write nothing of the person's. Only
 * PATH comes from outside, so node and git are found.
 *
 * The folder is kept short: a host's socket lives under XDG_RUNTIME_DIR,
 * and a Unix socket's path can't pass 107 bytes.
 *
 * Each seal serves a realm of its own. A host's key is its realm and kind,
 * and a host starting reaps what a dead host under its key left running,
 * so seals sharing a realm could end each other's tool children.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostSocketPath } from "../../../../host/service/address.ts";

/** The longest path a Unix socket takes, less its closing zero. */
const SOCKET_PATH_LIMIT = 107;

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
	/** The private folder everything sealed lives under. */
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
	const root = await mkdtemp(join(tmpdir(), "e-"));
	const realm = `sealed-${randomBytes(3).toString("hex")}`;
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
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
		await rm(root, { recursive: true, force: true });
		throw new Error(
			`A sealed host's socket would be ${socket}, past ${SOCKET_PATH_LIMIT} bytes: run with a shorter TMPDIR`,
		);
	}
	return {
		root,
		home: join(root, SEALED_FOLDERS.HOME),
		realm,
		env,
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}
