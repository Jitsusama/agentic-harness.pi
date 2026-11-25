/**
 * What waits on the person, read for a session: every cell's want of
 * him, as the map and the CLI read it, and his look list. It only reads.
 * What acts in his name (going to a cell, opening or clearing a look) is
 * the /needs command he types (needs-command.ts), never a tool the model
 * calls, so no agent answers or clears anything as him.
 */

import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	type Look,
	standingLooksListed,
} from "../../../lib/mesh/looks/looks.ts";
import {
	NEEDS_COMMAND,
	type Need,
	needsFrom,
	unreadNeeds,
} from "../../../lib/mesh/needs.ts";
import { oneLine } from "../../../lib/mesh/one-line.ts";
import {
	SAID_COMMAND,
	type SaidTo,
	saidFrom,
	unreadSaid,
} from "../../../lib/mesh/said-to.ts";
import { lastedText } from "./said.ts";

/** How long the node's listing of cells may take to answer. */
const NEEDS_TIMEOUT_MS = 20_000;

/** The most of a refusal's words said back. */
const MOST_REFUSAL = 200;

/** How far back what the person said is read, and the most of it shown. */
const SAID_WITHIN_MS = 24 * 60 * 60 * 1000;
const MOST_SAID = 10;

/**
 * The most of what the person said that a model is shown of each thing,
 * since every session's model may read it: enough to place it, never a
 * whole message he wrote for one session alone.
 */
const MOST_SAID_SHOWN = 80;

/** The cells needing the person, or why they couldn't be read. */
export type NeedsRead = Read<{ readonly needs: readonly Need[] }>;

/** What the node gave, or why it couldn't be read. */
export type Read<T> =
	| ({ readonly ok: true } & T)
	| { readonly ok: false; readonly reason: string };

/** What the person said to sessions lately, or why it couldn't be read. */
export type SaidRead = Read<{ readonly said: readonly SaidTo[] }>;

/** The looks standing on the person's list, or why they couldn't be read. */
export type LooksRead = Read<{ readonly looks: readonly Look[] }>;

/** What waits on the person: the cells' wants, his look list, and what he said. */
export interface WhatWaits {
	readonly needs: NeedsRead;
	readonly looks: LooksRead;
	readonly said: SaidRead;
}

/** Whether every part of what waits was read. */
export function whollyRead(waits: WhatWaits): boolean {
	return waits.needs.ok && waits.looks.ok && waits.said.ok;
}

/** Run `mycelium` with `args`, answering its output or why it gave none. */
async function myceliumSays(
	exec: ExtensionAPI["exec"],
	args: readonly string[],
	signal: AbortSignal | undefined,
): Promise<Read<{ readonly stdout: string }>> {
	try {
		// Run from the root, as lib/mesh runs it, since a session's folder
		// may be a tree a sweep has taken.
		const ran = await exec("mycelium", [...args], {
			timeout: NEEDS_TIMEOUT_MS,
			cwd: "/",
			...(signal ? { signal } : {}),
		});
		// pi's exec answers a run its clock killed with code 0, its output
		// torn, so being killed is a failure whatever the code says.
		if (ran.killed) {
			return {
				ok: false,
				reason: `mycelium ${args[0]} was stopped before it answered, after at most ${NEEDS_TIMEOUT_MS / 1000} s`,
			};
		}
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

/** Why `command`'s answer couldn't be read, when none of its lines reads. */
function unreadReason(command: string, unread: string): string {
	return `mycelium ${command} answered nothing this harness reads: ${oneLine(unread).slice(0, MOST_REFUSAL)}`;
}

/** Read every cell needing the person from the machine's node. */
export async function needsRead(
	exec: ExtensionAPI["exec"],
	signal?: AbortSignal,
): Promise<NeedsRead> {
	const read = await myceliumSays(exec, NEEDS_COMMAND, signal);
	if (!read.ok) return read;
	const unread = unreadNeeds(read.stdout);
	if (unread !== undefined) {
		return { ok: false, reason: unreadReason("cells", unread) };
	}
	return { ok: true, needs: needsFrom(read.stdout) };
}

/** Read what the person said to sessions in the last day, from the node. */
export async function saidRead(
	exec: ExtensionAPI["exec"],
	now: number,
	signal?: AbortSignal,
): Promise<SaidRead> {
	const read = await myceliumSays(exec, SAID_COMMAND, signal);
	if (!read.ok) return read;
	const unread = unreadSaid(read.stdout);
	if (unread !== undefined) {
		return { ok: false, reason: unreadReason("said", unread) };
	}
	return {
		ok: true,
		said: saidFrom(read.stdout, now - SAID_WITHIN_MS, MOST_SAID),
	};
}

/**
 * Read the looks standing in `folder`: none when there is no folder yet,
 * and a failure when this session keeps none or it can't be read, so an
 * unread list never reads as an empty one.
 */
export async function looksRead(
	folder: string | undefined,
): Promise<LooksRead> {
	if (folder === undefined) {
		return { ok: false, reason: "this session keeps no look list" };
	}
	try {
		await stat(folder);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return { ok: true, looks: [] };
		}
		return {
			ok: false,
			reason: oneLine(String(error)),
		};
	}
	return { ok: true, looks: await standingLooksListed(folder) };
}

/** Read what waits on the person: the cells' wants, and the looks in `looks`. */
export async function whatWaits(
	exec: ExtensionAPI["exec"],
	looks: string | undefined,
	now: number = Date.now(),
	signal?: AbortSignal,
): Promise<WhatWaits> {
	const [needs, said, standing] = await Promise.all([
		needsRead(exec, signal),
		saidRead(exec, now, signal),
		looksRead(looks),
	]);
	return { needs, looks: standing, said };
}

/**
 * What waits, as a model is shown it: each thing the person said held
 * to its start, since any session's model may read it.
 */
export function forAModel(waits: WhatWaits): WhatWaits {
	if (!waits.said.ok) return waits;
	return {
		...waits,
		said: {
			ok: true,
			said: waits.said.said.map((one) => {
				// By code point, so a cut never splits a surrogate pair.
				const points = [...one.text];
				return {
					...one,
					text:
						points.length > MOST_SAID_SHOWN
							? `${points.slice(0, MOST_SAID_SHOWN).join("")}...`
							: one.text,
				};
			}),
		},
	};
}

/** The records a stored answer cites, each saying what it is. */
export function waitingRecords(waits: WhatWaits): readonly unknown[] {
	return [
		...(waits.needs.ok ? waits.needs.needs : []).map((need) => ({
			type: "need",
			...need,
		})),
		...(waits.looks.ok ? waits.looks.looks : []).map((look) => ({
			type: "look",
			...look,
		})),
		...(waits.said.ok ? waits.said.said : []).map((said) => ({
			type: "said",
			...said,
		})),
	];
}

/** The line a cut view keeps last: who acts on these. */
export const ONLY_THE_PERSON_ACTS =
	"Only the person acts on these, with /needs in a pi window or in the launcher.";

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
	const looks = waits.looks.ok
		? waits.looks.looks.length === 0
			? ["Nothing is on the person's look list."]
			: waits.looks.looks.map((look) => `- [${look.id}] ${lookLine(look)}`)
		: [`The look list couldn't be read: ${waits.looks.reason}.`];
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
	].join("\n");
}
