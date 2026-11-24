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
import {
	SAID_COMMAND,
	type SaidTo,
	saidFrom,
} from "../../../lib/mesh/said-to.ts";
import { lastedText } from "./said.ts";

/** How long the node's listing of cells may take to answer. */
const NEEDS_TIMEOUT_MS = 20_000;

/** The most of a refusal's words said back. */
const MOST_REFUSAL = 200;

/** How far back what the person said is read, and the most of it shown. */
const SAID_WITHIN_MS = 24 * 60 * 60 * 1000;
const MOST_SAID = 10;

/** The cells needing the person, or why they couldn't be read. */
export type NeedsRead = Read<{ readonly needs: readonly Need[] }>;

/** What the node gave, or why it couldn't be read. */
export type Read<T> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: string };

/** What the person said to sessions lately, or why it couldn't be read. */
export type SaidRead = Read<{ readonly said: readonly SaidTo[] }>;

/** What waits on the person: the cells' wants, his look list, and what he said. */
export interface WhatWaits {
	readonly needs: NeedsRead;
	readonly looks: readonly Look[];
	readonly said: SaidRead;
}

/** Run `mycelium` with `args`, answering its output or why it gave none. */
async function myceliumSays(
	exec: ExtensionAPI["exec"],
	args: readonly string[],
): Promise<Read<{ readonly stdout: string }>> {
	try {
		const ran = await exec("mycelium", [...args], {
			timeout: NEEDS_TIMEOUT_MS,
		});
		if (ran.code !== 0) {
			const said = oneLine(ran.stderr).slice(0, MOST_REFUSAL);
			return {
				ok: false,
				reason: `mycelium ${args[0]} ended ${ran.code}${said ? `: ${said}` : ""}`,
			};
		}
		return { ok: true, stdout: ran.stdout };
	} catch (error) {
		return {
			ok: false,
			reason: `mycelium couldn't be run: ${oneLine(String(error))}`,
		};
	}
}

/** Read every cell needing the person from the machine's node. */
export async function needsRead(
	exec: ExtensionAPI["exec"],
): Promise<NeedsRead> {
	const read = await myceliumSays(exec, NEEDS_COMMAND);
	return read.ok ? { ok: true, needs: needsFrom(read.stdout) } : read;
}

/** Read what the person said to sessions in the last day, from the node. */
export async function saidRead(
	exec: ExtensionAPI["exec"],
	now: number,
): Promise<SaidRead> {
	const read = await myceliumSays(exec, SAID_COMMAND);
	return read.ok
		? { ok: true, said: saidFrom(read.stdout, now - SAID_WITHIN_MS, MOST_SAID) }
		: read;
}

/** Read what waits on the person: the cells' wants, and the looks in `looks`. */
export async function whatWaits(
	exec: ExtensionAPI["exec"],
	looks: string | undefined,
	now: number = Date.now(),
): Promise<WhatWaits> {
	const [needs, said] = await Promise.all([
		needsRead(exec),
		saidRead(exec, now),
	]);
	return {
		needs,
		looks: looks === undefined ? [] : standingLooksIn(looks),
		said,
	};
}

/** One thing the person said, and how it stands, on a line. */
export function saidLine(said: SaidTo, now: number): string {
	const where = said.machine ? ` on ${said.machine}` : "";
	return `to ${said.address}${where}, ${lastedText(now - Date.parse(said.at))} ago: ${said.text || "(an act)"} (${said.standing})`;
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
	const said = waits.said.ok
		? waits.said.said.length === 0
			? ["Nothing in the last day."]
			: waits.said.said.map((one) => `- ${saidLine(one, now)}`)
		: [`What the person said couldn't be read: ${waits.said.reason}.`];
	return [
		"Cells needing the person, longest waiting first:",
		...needs,
		"",
		"The person's look list, newest first:",
		...looks,
		"",
		"What the person said to sessions from outside their windows, newest first, and how each stands:",
		...said,
		"",
		"Only the person acts on these, with /needs in a pi window or in the launcher.",
	].join("\n");
}
