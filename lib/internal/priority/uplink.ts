/**
 * How fast the machine's uplink is sending, for the queue to publish
 * beside its pressure. Nothing in the queue waits on it: builds take
 * their turns by memory and CPU. The shell reads it to pace what makes
 * sessions send. On 14 November seventy-two sessions told to carry on
 * at once sent 6.4 Mbit/s of the home line's measured 8.2 for seventeen
 * minutes, and the builders sharing that line waited.
 *
 * It counts what leaves by the default route's interface, so traffic
 * tunnelled through the work VPN counts too, as the line carries it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** How far back the rate is measured from, in milliseconds. */
export const UPLINK_WINDOW_MS = 10_000;

/** The kernel's files the uplink is read from, so a test can stand in. */
export interface UplinkFiles {
	readonly proc: string;
	readonly net: string;
}

/** Where Linux keeps each interface's counters. */
export const NET = "/sys/class/net";

/** What an interface has sent since it came up. */
export interface UplinkSent {
	readonly device: string;
	readonly bytes: number;
}

const DEFAULT_DESTINATION = "00000000";
// RTF_UP, in /proc/net/route's hexadecimal Flags.
const ROUTE_UP = 0x1;
const HEX = 16;
const BITS_PER_BYTE = 8;
const BITS_PER_MBIT = 1_000_000;
const MS_PER_S = 1000;
const HUNDREDTHS = 100;

/**
 * The interface the default route leaves by, in /proc/net/route's
 * table: the lowest metric among default routes that are up, as the
 * kernel picks it. Nothing when none stands.
 */
export function defaultInterfaceIn(route: string): string | undefined {
	const routes = route
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/u))
		.filter(
			([, destination, , flags, , , , mask]) =>
				destination === DEFAULT_DESTINATION &&
				mask === DEFAULT_DESTINATION &&
				(Number.parseInt(flags ?? "0", HEX) & ROUTE_UP) !== 0,
		)
		.map(([device, , , , , , metric]) => ({
			device: device ?? "",
			metric: Number(metric),
		}))
		.sort((a, b) => a.metric - b.metric);
	return routes[0]?.device || undefined;
}

/** What the default route's interface has sent, where it can be read. */
export async function uplinkSentIn(
	files: UplinkFiles = { proc: "/proc", net: NET },
): Promise<UplinkSent | undefined> {
	try {
		const device = defaultInterfaceIn(
			await readFile(join(files.proc, "net", "route"), "utf8"),
		);
		if (device === undefined) return undefined;
		const bytes = Number(
			await readFile(join(files.net, device, "statistics", "tx_bytes"), "utf8"),
		);
		return Number.isFinite(bytes) ? { device, bytes } : undefined;
	} catch {
		// A machine with no route table or counters says nothing of its
		// uplink, which the shell reads as not yet measured.
		return undefined;
	}
}

/**
 * Measures the uplink's rate from what was sent, read as often as the
 * queue reads its room: over the newest reading at least
 * {@link UPLINK_WINDOW_MS} old, so a reading every second still measures
 * a window and a rarer one measures since the last. It says nothing
 * until such a reading stands, and starts again when the interface
 * changes, its count goes back, or it can't be read.
 */
export function uplinkMeter(): (
	sent: UplinkSent | undefined,
	now: number,
) => number | undefined {
	let seen: { readonly at: number; readonly sent: UplinkSent }[] = [];
	return (sent, now) => {
		const last = seen.at(-1)?.sent;
		if (
			sent === undefined ||
			(last !== undefined &&
				(last.device !== sent.device || sent.bytes < last.bytes))
		) {
			seen = [];
		}
		if (sent === undefined) return undefined;
		seen.push({ at: now, sent });
		const old = now - UPLINK_WINDOW_MS;
		while (seen.length > 1 && (seen[1]?.at ?? now) <= old) seen.shift();
		const from = seen[0];
		if (from === undefined || from.at > old) return undefined;
		const mbit =
			((sent.bytes - from.sent.bytes) * BITS_PER_BYTE) / BITS_PER_MBIT;
		const seconds = (now - from.at) / MS_PER_S;
		return Math.round((mbit / seconds) * HUNDREDTHS) / HUNDREDTHS;
	};
}
