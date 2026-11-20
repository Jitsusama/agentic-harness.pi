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
 * `pi-host/KEY.d/`: SLOT.json, written before the unit starts, says
 * which conversation it resumes (none for a new open), and SLOT.sock is
 * where the child listens. The slot is the conversation's id for a
 * resume and a fresh one for an open; the child names its conversation
 * when it is watched, so routes go by that, never by the slot.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** What one child's slot holds: the conversation it resumes, if any. */
export interface Slot {
	readonly name: string;
	readonly socket: string;
	readonly file: string;
	readonly unit: string;
}

/** How the supervisor asks systemd about its children's units. */
export interface Units {
	/** Start a unit, settling once systemd has taken the job. */
	start(unit: string): Promise<void>;
	/** Whether a unit is running now. */
	active(unit: string): Promise<boolean>;
	/** Stop a unit, settling once systemd has taken the job. */
	stop(unit: string): Promise<void>;
}

/** A slot's name: a uuid, so it names no path but its own. */
const SLOT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The folder a host's children keep their slots in. */
export function slotFolder(runtimeDir: string, key: string): string {
	if (!isAbsolute(runtimeDir))
		throw new Error("Children need an absolute runtime folder");
	return join(runtimeDir, "pi-host", `${key}.d`);
}

/** The slot `name` names in `folder`, for the host keyed `key`. */
export function slotOf(folder: string, key: string, name: string): Slot {
	if (!SLOT_NAME.test(name)) throw new Error(`Not a slot's name: ${name}`);
	return {
		name,
		socket: join(folder, `${name}.sock`),
		file: join(folder, `${name}.json`),
		unit: `pi-conversation-${key}@${name}.service`,
	};
}

/** Write what the child in `slot` resumes, before its unit starts. */
export async function writeSlot(
	slot: Slot,
	session: string | undefined,
): Promise<void> {
	await mkdir(join(slot.file, ".."), { recursive: true, mode: 0o700 });
	await writeFile(slot.file, `${JSON.stringify(session ? { session } : {})}\n`, {
		mode: 0o600,
	});
}

/** Remove a slot's files, once its child has gone. */
export async function clearSlot(slot: Slot): Promise<void> {
	await rm(slot.file, { force: true });
	await rm(slot.socket, { force: true });
}

/** The slots in `folder`, each named by a SLOT.json in it. */
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
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((name) => SLOT_NAME.test(name))
		.map((name) => slotOf(folder, key, name));
}

function systemctl(...args: string[]): Promise<{ code: number }> {
	return new Promise((resolve, reject) => {
		execFile("systemctl", ["--user", ...args], (error) => {
			if (!error) return resolve({ code: 0 });
			const code = Reflect.get(error, "code");
			if (typeof code === "number") return resolve({ code });
			reject(error);
		});
	});
}

/** The user's systemd, as it runs each child's unit. */
export const systemdUnits: Units = {
	async start(unit) {
		const { code } = await systemctl("start", "--no-block", unit);
		if (code !== 0) throw new Error(`systemd would not start ${unit}`);
	},
	async active(unit) {
		return (await systemctl("is-active", "--quiet", unit)).code === 0;
	},
	async stop(unit) {
		const { code } = await systemctl("stop", "--no-block", unit);
		if (code !== 0) throw new Error(`systemd would not stop ${unit}`);
	},
};
