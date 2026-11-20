/**
 * Where each child runs: a systemd unit of its own, and a slot of files.
 *
 * A conversation's child is an instance of the template unit core's
 * host.nix writes for the host's key, `pi-conversation-KEY@SLOT.service`,
 * so a host restart stops no conversation and systemd accounts each
 * one's memory alone. The template carries the host's environment, so
 * nothing secret passes through this code or a transient unit's record.
 *
 * A slot names one child's files in the host's runtime folder,
 * `pi-host/KEY.d/`: SLOT.json, written before the unit starts, holds
 * the roster entry of the conversation it resumes (none for a new
 * open), SLOT.sock is where the child listens, and SLOT.d/ is the
 * child's own, for its life, which nothing here reads. The slot is the conversation's id for a
 * resume and a fresh one for an open; the child names its conversation
 * when it is watched, so routes go by that, never by the slot.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	isHostKey,
	isSessionId,
	type RosterEntry,
} from "../../lib/core/session/roster.ts";
import { MAX_SOCKET_PATH_BYTES } from "./address.ts";

/** Where one child's files are, and the unit it runs as. */
export interface Slot {
	readonly name: string;
	readonly socket: string;
	readonly file: string;
	readonly folder: string;
	readonly unit: string;
}

/** How the supervisor asks systemd about its children's units. */
export interface Units {
	/** Start a unit, settling once systemd has taken the job. */
	start(unit: string): Promise<void>;
	/**
	 * Whether a unit has gone: stopped or failed, with nothing queued
	 * for it, rather than starting, running or stopping.
	 */
	gone(unit: string): Promise<boolean>;
	/** Stop a unit, settling once systemd has taken the job. */
	stop(unit: string): Promise<void>;
	/**
	 * Have systemd forget a unit that has gone, so one that failed isn't
	 * left listed as failed: each open's child is a unit of its own,
	 * never started again. Never throws, since nothing waits on it.
	 */
	forget(unit: string): Promise<void>;
}

/** The folder a host's children keep their slots in. */
export function slotFolder(runtimeDir: string, key: string): string {
	if (!isAbsolute(runtimeDir))
		throw new Error("Children need an absolute runtime folder");
	return join(runtimeDir, "pi-host", `${key}.d`);
}

/** The slot `name` names in `folder`, for the host keyed `key`. */
export function slotOf(folder: string, key: string, name: string): Slot {
	// A conversation's id, so it names no path or unit but its own.
	if (!isSessionId(name)) throw new Error(`Not a slot's name: ${name}`);
	if (!isHostKey(key)) throw new Error(`Not a host's key: ${key}`);
	const socket = join(folder, `${name}.sock`);
	if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES)
		throw new Error(`A child's socket would be too long a path: ${socket}`);
	return {
		name,
		socket,
		file: join(folder, `${name}.json`),
		folder: join(folder, `${name}.d`),
		unit: `pi-conversation-${key}@${name}.service`,
	};
}

/**
 * Write what the child in `slot` resumes, before its unit starts:
 * `woken` when a park's wake asked for it, so the child keeps the wake
 * rather than resting parked again.
 */
export async function writeSlot(
	slot: Slot,
	session: RosterEntry | undefined,
	woken = false,
): Promise<void> {
	await mkdir(join(slot.file, ".."), { recursive: true, mode: 0o700 });
	const held = session ? { session, ...(woken ? { woken } : {}) } : {};
	await writeFile(slot.file, `${JSON.stringify(held)}\n`, { mode: 0o600 });
}

/** Remove a slot's files, once its child has gone. */
export async function clearSlot(slot: Slot): Promise<void> {
	await rm(slot.file, { force: true });
	await rm(slot.socket, { force: true });
	await rm(slot.folder, { force: true, recursive: true });
}

/**
 * The slots in `folder`, each named by any of its files, so one a child
 * left half cleared is found too.
 */
export async function slotsIn(folder: string, key: string): Promise<Slot[]> {
	let names: string[];
	try {
		names = await readdir(folder);
	} catch (error) {
		// No folder yet: no child has ever started under this key.
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
			return [];
		throw error;
	}
	const named = new Set(
		names
			.map((name) => name.replace(/\.(json|sock|d)$/, ""))
			.filter((name) => isSessionId(name)),
	);
	return [...named].map((name) => slotOf(folder, key, name));
}

/** What `systemctl --user` said: its exit code, what it printed and why. */
export interface Said {
	readonly code: number;
	readonly out: string;
	readonly err?: string;
}

/** Runs `systemctl --user` with these arguments. */
export type Systemctl = (args: readonly string[]) => Promise<Said>;

/**
 * How long `systemctl --user` may take to answer: it only queues a job
 * or reads a state, so one past this has a user manager that hangs,
 * and a slot waiting on it would otherwise wait for good.
 */
export const SYSTEMCTL_WITHIN_MS = 10_000;

const systemctl: Systemctl = (args) =>
	new Promise((resolve, reject) => {
		execFile(
			"systemctl",
			["--user", ...args],
			{ timeout: SYSTEMCTL_WITHIN_MS },
			(error, out, err) => {
				if (!error) return resolve({ code: 0, out, err });
				const code = Reflect.get(error, "code");
				if (typeof code === "number") return resolve({ code, out, err });
				if (error.killed)
					return reject(
						new Error(
							`systemctl --user ${args.join(" ")} gave no answer within ${SYSTEMCTL_WITHIN_MS} ms`,
						),
					);
				reject(error);
			},
		);
	});

/** What systemd said a refusal was for, after `what`, or `what` alone. */
function refused(what: string, { err }: Said): Error {
	const why = err?.trim();
	return new Error(why ? `${what}: ${why}` : what);
}

/** The states a unit with nothing queued for it has gone in. */
const GONE = new Set(["inactive", "failed"]);

/**
 * A child's units as `run` asks systemd for them: started and stopped
 * without waiting on the job, so a unit whose start waits on a
 * readiness it never signals holds no one, and gone only once
 * stopped or failed with no job left, since a unit still activating,
 * or deactivating with a start queued behind it, is no unit gone.
 */
export function unitsOver(run: Systemctl): Units {
	return {
		async start(unit) {
			const said = await run(["start", "--no-block", unit]);
			if (said.code !== 0)
				throw refused(`systemd would not start ${unit}`, said);
		},
		async gone(unit) {
			const shown = await run(["show", "--property=ActiveState,Job", unit]);
			const { code, out } = shown;
			if (code !== 0)
				throw refused(`systemd would not say how ${unit} is`, shown);
			const said = new Map(
				out
					.split("\n")
					.filter((row) => row.includes("="))
					.map((row) => [
						row.slice(0, row.indexOf("=")),
						row.slice(row.indexOf("=") + 1),
					]),
			);
			return GONE.has(said.get("ActiveState") ?? "") && !said.get("Job");
		},
		async stop(unit) {
			const said = await run(["stop", "--no-block", unit]);
			if (said.code !== 0)
				throw refused(`systemd would not stop ${unit}`, said);
		},
		async forget(unit) {
			try {
				// Refused for a unit not failed, which has nothing to forget.
				await run(["reset-failed", unit]);
			} catch {
				// A user manager that hangs keeps a failed unit listed, no worse.
			}
		},
	};
}

/** The user's systemd, as it runs each child's unit. */
export const systemdUnits: Units = unitsOver(systemctl);
