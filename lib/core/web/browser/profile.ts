/**
 * This process's Chrome profile: where it lives, the owner record
 * written into it, and the startup sweep of profiles whose owner
 * has died.
 *
 * Kept apart from the launch because the profile is how one process
 * tells its own Chrome from another's and from an orphan, and that
 * record's shape and liveness rules change on their own.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processGlobal } from "../../../internal/process/process-global.ts";
import { findProcsByProfile, verifyBrowser } from "../procs.ts";
import { killPidGroup, type OwnerRecord, reapOrphans } from "./reaping.ts";

/**
 * Parent dir for per-launch Chrome profiles. Each launch gets
 * its own subdir; a startup sweep removes the ones left behind
 * by a prior run that a SIGKILL or crash could not clean, which
 * is the orphan the clean-exit teardown never reclaims.
 */
export const PROFILE_ROOT = path.join(os.tmpdir(), "pi-web-chrome");

/**
 * This process's own profile directory, resolved once and shared
 * across extension module instances. The name carries a random
 * generation nonce alongside the pid, so a reused pid can never
 * collide with a previous run's directory and the reaper can treat
 * a live pid as its owner without a fragile start-time probe.
 */
export function ownProfileDir(): string {
	return processGlobal("pi:web-chrome-profile", () =>
		path.join(
			PROFILE_ROOT,
			`${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
		),
	);
}

/** The ownership record path inside a profile dir. */
function ownerFile(profileDir: string): string {
	return path.join(profileDir, "owner.json");
}

/** Read a profile's ownership record, or undefined if absent or unreadable. */
export function readOwnerRecord(profileDir: string): OwnerRecord | undefined {
	try {
		const raw = fs.readFileSync(ownerFile(profileDir), "utf8");
		const rec = JSON.parse(raw);
		if (typeof rec?.ownerPid === "number") return rec;
	} catch {
		// No record, or malformed; the caller treats this as no record.
	}
	return undefined;
}

/** True when a pid names a live process (EPERM still means it exists). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Record who owns this profile, which Chrome pid it launched, and how a
 * separate process can reach that same browser. */
export function writeOwnerRecord(
	profileDir: string,
	browserPid?: number,
	browserWSEndpoint?: string,
): void {
	const record: OwnerRecord = {
		ownerPid: process.pid,
		browserPid,
		browserWSEndpoint,
	};
	try {
		fs.writeFileSync(ownerFile(profileDir), JSON.stringify(record));
	} catch {
		// A missing record only downgrades a future reap to bare-pid
		// liveness, so a write failure is not worth failing the launch.
	}
}

/**
 * Reap Chrome trees and profile dirs left behind by a prior run.
 * A dir is reaped only when its owning process is provably dead, so a
 * live sibling process keeps its browser; the recorded Chrome pid is
 * killed only after an exact re-verify.
 */
export function reapOrphanProfiles(): void {
	reapOrphans({
		root: PROFILE_ROOT,
		listEntries: () => {
			try {
				return fs.readdirSync(PROFILE_ROOT);
			} catch {
				// No profile root yet; nothing to reap.
				return [];
			}
		},
		readOwner: readOwnerRecord,
		isPidAlive,
		verifyBrowser,
		findProcsByProfile,
		killPid: (pid) => killPidGroup(pid),
		removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
	});
}
