/**
 * The node's worker socket, the one socket of the mycelium node's a
 * fenced or strict command may reach, on a machine with no mesh of its
 * own, such as a cloud VM (`lib/mesh/worker-link.ts`). Landlock refuses
 * every socket it isn't told of, so on S99IA2's VM trial (24 November) a
 * strict start found no node at all.
 *
 * Let through by what it is, never by what it isn't: the node serves it
 * as `/run/mycelium/<realm>-worker.sock` (KP0L6A, 24 November), in a
 * folder the machine makes at boot, and nothing else is. A path the
 * variable names anywhere else, under another name, through a link in
 * any part of it, or as anything but a socket, is not the worker socket
 * and gets nothing; so neither the node's full socket, which lives in the
 * runtime folder, nor a socket the fence keeps out can pass as it.
 *
 * Landlock is told of the folder rather than the socket, since a rule
 * holds an inode and a node that restarts binds a new one: told of the
 * socket, a fenced agent lost the node at its first restart (tried on
 * optimus, 24 November). So the rule reaches every socket in the folder,
 * not only the one the variable names: another realm's worker socket the
 * same node serves there among them. The node keeps nothing else there,
 * and the folder must be made once, at boot, as a tmpfiles folder is: one
 * remade at each start of the node is a new inode the rule never reaches.
 * Landlock judges the socket a connect reaches where it really is, so a
 * link put in the folder later reaches nothing outside it.
 *
 * The bubblewrap fence binds the folder read-only over itself, so a
 * command running as the account that owns it can't take the socket away
 * and listen in the node's place for every other session, as the agent
 * proxy's is (JMJ7J4); a folder bound, not the socket, still shows the
 * one a restarted node binds. A node between restarts, its socket not yet
 * bound again, still has its folder let through and its path handed on,
 * so a command started then reaches the node once it is back.
 *
 * The command learns the path from the variable, handed on only when the
 * socket is let through and never to a language server's sandbox, which
 * runs no one's ask; every other value of it is left out.
 */

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	WORKER_SOCKET_VARIABLE,
	workerSocket,
} from "../../mesh/worker-link.ts";

/** The folder the node serves its worker sockets in, one a realm. */
export const WORKER_SOCKET_FOLDER = "/run/mycelium";

/** A worker socket's name, its realm's then `-worker.sock`. */
const WORKER_SOCKET_NAME = /^[a-z0-9][a-z0-9_-]*-worker\.sock$/;

/** The mode bits that let a group or anyone else write a folder. */
const WRITTEN_BY_OTHERS = 0o022;

/** What the worker socket's check reads of the disk; a test hands in its own. */
export interface SocketDisk {
	/** Where a path ends once every link in it is followed, if anywhere. */
	real(path: string): string | undefined;
	/** Whether anything is at a path, not following a link it ends in. */
	present(path: string): boolean;
	/** Whether a path is a socket, not following a link it ends in. */
	isSocket(path: string): boolean;
	/**
	 * Whether only the folder's owner may write it, and root or this
	 * process's own account chose that owner, so nobody else can put a
	 * socket of their own in it ({@link keptFolder}).
	 */
	keptByItsOwner(folder: string): boolean;
}

/** What {@link keptFolder} reads of a folder. */
export interface FolderStat {
	readonly uid: number;
	readonly mode: number;
	readonly isFolder: boolean;
}

/**
 * Whether `folder`, read by `stat` (which follows no link), is written
 * by its owner alone, and that owner is root, `uid`, or the account
 * root gave it to: a folder whose own folder only root may write, as
 * `/run` is, was made there by root, so whoever owns it root chose. The
 * node's NixOS module makes `/run/mycelium` at boot owned by the node's
 * account, which on a VM need not be the session's (KP0L6A, 24
 * November).
 */
export function keptFolder(
	folder: string,
	stat: (path: string) => FolderStat | undefined,
	uid: number | undefined,
): boolean {
	const own = stat(folder);
	if (own === undefined || !own.isFolder) return false;
	if ((own.mode & WRITTEN_BY_OTHERS) !== 0) return false;
	if (own.uid === 0 || own.uid === uid) return true;
	const parent = stat(dirname(folder));
	return (
		parent?.isFolder === true &&
		parent.uid === 0 &&
		(parent.mode & WRITTEN_BY_OTHERS) === 0
	);
}

/** `path` as {@link keptFolder} reads it, or nothing when it can't be. */
function folderStat(path: string): FolderStat | undefined {
	try {
		const stat = lstatSync(path);
		return { uid: stat.uid, mode: stat.mode, isFolder: stat.isDirectory() };
	} catch {
		// No folder, so no socket in it.
		return undefined;
	}
}

/** The disk as it is. */
export const SOCKET_DISK: SocketDisk = {
	real(path) {
		try {
			return realpathSync(path);
		} catch {
			// Nothing there, so nothing to let through.
			return undefined;
		}
	},
	present(path) {
		try {
			lstatSync(path);
			return true;
		} catch {
			// Nothing there to read.
			return false;
		}
	},
	isSocket(path) {
		try {
			return lstatSync(path).isSocket();
		} catch {
			// Nothing there, so nothing to let through.
			return false;
		}
	},
	keptByItsOwner: (folder) =>
		keptFolder(folder, folderStat, process.getuid?.()),
};

/**
 * The worker socket a fenced command in `env` may reach, or none: none
 * where the machine names none, or names a path that isn't the node's
 * worker socket as it really stands on disk. Nothing there yet is a node
 * between restarts, and passes, since the folder is what is let through.
 */
export function fencedWorkerSocket(
	env: NodeJS.ProcessEnv,
	disk: SocketDisk = SOCKET_DISK,
): string | undefined {
	const named = workerSocket(env);
	if (named === undefined) return undefined;
	if (dirname(named) !== WORKER_SOCKET_FOLDER) return undefined;
	if (!WORKER_SOCKET_NAME.test(basename(named))) return undefined;
	if (disk.real(WORKER_SOCKET_FOLDER) !== WORKER_SOCKET_FOLDER)
		return undefined;
	if (!disk.keptByItsOwner(WORKER_SOCKET_FOLDER)) return undefined;
	if (!disk.present(named)) return named;
	if (disk.real(named) !== named) return undefined;
	return disk.isSocket(named) ? named : undefined;
}

/** What Landlock is told of for `socket`: the folder it lies in. */
export function workerSocketRule(socket: string): string {
	return dirname(socket);
}

/** The variable a command is handed for `socket`, or none without one. */
export function workerSocketPassed(
	socket: string | undefined,
): Record<string, string> {
	return socket ? { [WORKER_SOCKET_VARIABLE]: socket } : {};
}
