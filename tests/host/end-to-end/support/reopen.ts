/**
 * What the launcher's Reopen Them All would open from a seal's session
 * records on the boot after this one: the restore file the harness would
 * write then (lib/internal/quest/restore-file.ts), read as the launcher
 * reads it (core.nix's modules/quickshell/Sessions.qml, restoreOf). An
 * entry marked `hosted` is kept, but only its viewer opens, since its
 * host brings the conversation back and a pi too would start it twice;
 * before core.nix #3316 it was left out, and its window was lost.
 *
 * Read on the next boot rather than this one, because on this boot the
 * file offers nothing at all, hosted or not: only a boot that ended
 * with sessions running has any to offer.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type RestoreEntry,
	type RestoreFile,
	restoreFileOf,
	type SeenRecord,
} from "../../../../lib/internal/quest/restore-file.ts";
import { parseSessionRecord } from "../../../../lib/internal/quest/session-registry.ts";
import type { Seal } from "./seal.ts";

/** The boot after this one, as far as the records can tell. */
const NEXT_BOOT = "the-next-boot";

/** Every session record under the seal, in each realm's registry. */
function sealedRecords(seal: Seal): SeenRecord[] {
	const root = join(seal.env.XDG_STATE_HOME ?? "", "pi", "agentic-harness.pi");
	const realms = (() => {
		try {
			return readdirSync(join(root, "realms")).map((one) =>
				join(root, "realms", one),
			);
		} catch {
			// No realm of its own: only the home realm's folder.
			return [];
		}
	})();
	const seen: SeenRecord[] = [];
	for (const folder of [root, ...realms]) {
		const registry = join(folder, "quest-workflow", "sessions");
		let names: string[] = [];
		try {
			names = readdirSync(registry).filter((name) => name.endsWith(".json"));
		} catch {
			// This realm has recorded no session.
		}
		for (const name of names) {
			const path = join(registry, name);
			try {
				const record = parseSessionRecord(
					JSON.parse(readFileSync(path, "utf8")),
				);
				if (record)
					seen.push({
						record,
						heartbeatAt: statSync(path).mtime.toISOString(),
					});
			} catch {
				// Half-written as it is renamed in: the harness skips it too.
			}
		}
	}
	return seen;
}

/** The restore file the harness would write on the next boot. */
export function nextBootRestore(seal: Seal): RestoreFile {
	return restoreFileOf(sealedRecords(seal), NEXT_BOOT);
}

/** What Reopen Them All opens for one entry of a restore file. */
export interface Reopened {
	readonly id: string;
	/** A viewer of its host's conversation, or a pi that starts it. */
	readonly opens: "viewer" | "pi";
}

/**
 * What the launcher would open for each entry of a restore file: a
 * viewer for one marked hosted, a pi for any other.
 */
export function launcherReopens(file: RestoreFile): Reopened[] {
	return file.sessions.map((one: RestoreEntry) => ({
		id: one.id,
		opens: one.hosted === true ? "viewer" : "pi",
	}));
}
