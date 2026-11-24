/**
 * What waits on the person, read for a session: every cell's want of
 * him, as the map and the CLI read it, and his look list. It only reads.
 * What acts in his name (going to a cell, opening or clearing a look) is
 * the /needs command he types (needs-command.ts), never a tool the model
 * calls, so no agent answers or clears anything as him.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Look, standingLooksIn } from "../../../lib/mesh/looks/looks.ts";
import {
	NEEDS_COMMAND,
	type Need,
	needsFrom,
} from "../../../lib/mesh/needs.ts";
import { oneLine } from "../../../lib/mesh/one-line.ts";
import { lastedText } from "./said.ts";

/** How long the node's listing of cells may take to answer. */
const NEEDS_TIMEOUT_MS = 20_000;

/** The most of a refusal's words said back. */
const MOST_REFUSAL = 200;

/** The cells needing the person, or why they couldn't be read. */
export type NeedsRead =
	| { readonly ok: true; readonly needs: readonly Need[] }
	| { readonly ok: false; readonly reason: string };

/** What waits on the person: the cells' wants, and his look list. */
export interface WhatWaits {
	readonly needs: NeedsRead;
	readonly looks: readonly Look[];
}

/** Read every cell needing the person from the machine's node. */
export async function needsRead(
	exec: ExtensionAPI["exec"],
): Promise<NeedsRead> {
	try {
		const ran = await exec("mycelium", [...NEEDS_COMMAND], {
			timeout: NEEDS_TIMEOUT_MS,
		});
		if (ran.code !== 0) {
			const said = oneLine(ran.stderr).slice(0, MOST_REFUSAL);
			return {
				ok: false,
				reason: `the node's listing ended ${ran.code}${said ? `: ${said}` : ""}`,
			};
		}
		return { ok: true, needs: needsFrom(ran.stdout) };
	} catch (error) {
		return {
			ok: false,
			reason: `mycelium couldn't be run: ${oneLine(String(error))}`,
		};
	}
}

/** Read what waits on the person: the cells' wants, and the looks in `looks`. */
export async function whatWaits(
	exec: ExtensionAPI["exec"],
	looks: string | undefined,
): Promise<WhatWaits> {
	return {
		needs: await needsRead(exec),
		looks: looks === undefined ? [] : standingLooksIn(looks),
	};
}

/** One cell's want of the person, on a line. */
export function needLine(need: Need, now: number): string {
	const where = need.machine ? ` on ${need.machine}` : "";
	const waited =
		need.since === undefined
			? ""
			: `, waiting ${lastedText(now - Date.parse(need.since))}`;
	const about = need.title ? ` (${need.title})` : "";
	return `${need.name}${where}${waited}: ${need.asks || "needs you"}${about}`;
}

/** One look on the person's list, on a line. */
export function lookLine(look: Look): string {
	const why = oneLine(look.happened || look.why);
	const asks = look.asks === false ? "" : ", asks a word back";
	const from = look.address ? ` from ${look.address}` : "";
	return `${oneLine(look.title)}${from} (${look.kind}${asks}${look.state === "opened" ? ", opened" : ""})${why ? `: ${why}` : ""}`;
}

/** What waits on the person, as a session reads it. */
export function whatWaitsText(waits: WhatWaits, now: number): string {
	const needs = waits.needs.ok
		? waits.needs.needs.length === 0
			? ["No cell needs the person now."]
			: waits.needs.needs.map((need) => `- ${needLine(need, now)}`)
		: [`The cells couldn't be read: ${waits.needs.reason}.`];
	const looks =
		waits.looks.length === 0
			? ["Nothing is on the person's look list."]
			: waits.looks.map((look) => `- [${look.id}] ${lookLine(look)}`);
	return [
		"Cells needing the person, longest waiting first:",
		...needs,
		"",
		"The person's look list, newest first:",
		...looks,
		"",
		"Only the person acts on these, with /needs in a pi window or in the launcher.",
	].join("\n");
}
