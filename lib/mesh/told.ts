/**
 * Who a peer has told of an overlap, kept on disk so every process of
 * the peer remembers.
 *
 * When a peer reaches for a file another is changing, the holder is
 * sent an fyi saying so. Each process kept its own memory of what it
 * had told, keyed by the holder's lease and when it was taken, so a
 * subagent, a hand, a reloaded session, or the holder retaking its claim
 * at the start of a run each told again. On 2026-10-31 one walgit file
 * drew 327 such fyis from 123 processes (RSCH-20261031-GUDOJV, piece 2).
 *
 * So a telling is remembered here by teller, holder, kind and subject,
 * leaving out when the lease was taken, and for as long as an fyi is
 * news. A hand tells as the peer it works for, so it shares the peer's
 * memory. One file per telling, written whole, so two processes telling
 * at once lose nothing worse than one extra fyi.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "../internal/write-whole.ts";
import { FYI_MS } from "./attention.ts";

/** How long a telling stands: as long as the fyi it sent is news. */
export const TOLD_FOR_MS = FYI_MS;

/** What one telling is about. */
export interface Telling {
	/** The teller's signature, which its hands share. */
	readonly teller: string;
	/** The holder's session. */
	readonly holder: string;
	readonly kind: string;
	readonly subject: string;
}

/** The tellings peers have made, as the machine keeps them. */
export interface Told {
	/** Whether this telling was made within {@link TOLD_FOR_MS} of `now`. */
	already(telling: Telling, now: number): boolean;
	/** Remember this telling as made at `now`. */
	note(telling: Telling, now: number): void;
}

/** The tellings kept in `dir`. */
export function toldIn(dir: string): Told {
	const fileOf = (telling: Telling) => {
		const key = keyOf(telling);
		const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
		return { key, file: join(dir, `${name}.json`) };
	};
	return {
		already(telling, now) {
			const { key, file } = fileOf(telling);
			try {
				const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
				if (typeof kept !== "object" || kept === null) return false;
				const { key: keptKey, at } = kept as Record<string, unknown>;
				return (
					keptKey === key &&
					typeof at === "string" &&
					now - Date.parse(at) < TOLD_FOR_MS
				);
			} catch {
				// Never told, or torn: telling again costs one fyi.
				return false;
			}
		},
		note(telling, now) {
			const { key, file } = fileOf(telling);
			try {
				writeWhole(
					file,
					JSON.stringify({ key, at: new Date(now).toISOString() }),
				);
				forgetStale(dir, now);
			} catch {
				// A machine that can't keep it tells again, as it did before.
			}
		},
	};
}

function keyOf(telling: Telling): string {
	return [telling.teller, telling.holder, telling.kind, telling.subject].join(
		"|",
	);
}

/** Remove tellings past their time, so the folder holds about an hour's. */
function forgetStale(dir: string, now: number): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const file = join(dir, name);
		try {
			if (now - statSync(file).mtimeMs >= TOLD_FOR_MS) rmSync(file);
		} catch {
			// Gone already, removed by another peer sweeping beside this one.
		}
	}
}
