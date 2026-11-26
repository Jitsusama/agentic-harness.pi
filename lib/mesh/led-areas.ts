/**
 * The areas each quest led in what it landed, said as its cell's subjects.
 *
 * A cell's subjects come from its owner lines and its quest's README
 * (subjects.ts), and on 25 November no README listed any, so a need was
 * routed by title words, and a broad cell's title names none of its
 * areas. Each merge now says the areas it touched
 * (internal/session/changed-areas.ts), and the landing history keeps
 * them a month, so what a quest has proved by merging can be said for
 * it rather than declared.
 *
 * A quest says an area it leads, not every area it touched, or the
 * broadest cells would hold every word and take every need. Leading is
 * landing it at least {@link FEWEST_LANDINGS} times in the last
 * {@link LED_WITHIN_MS}, with at least {@link LEADS_AT} of the weight of
 * the quest that landed it most, each landing weighing half as much
 * every {@link HALF_LIFE_MS}, so one sweeping refactor doesn't claim an
 * area for a fortnight.
 *
 * A landing is credited to the quest that proposed the change, as the
 * record of proposals on the machine it landed on knows it, and a
 * landing whose proposer it doesn't know leads nothing. The harness's
 * gate merges on optimus what other cells proposed on the Mac, whose
 * record optimus never reads, and crediting the merger made the gate
 * lead what they wrote (FZ9MFJ, 25 November): a missing lead routes a
 * need by title words as before, a wrong one routes it to the gate.
 * Never the quest's parent either, since rolled up an orchestrator
 * would lead everything.
 *
 * A subject is said as the repository's name and the area,
 * `agentic-harness.pi:extensions/review-integration`, since routing
 * reads a subject's narrowest part after its last colon, dot or slash:
 * that one is held as review, integration and review-integration.
 *
 * A subject whose narrowest part gives routing no word, as
 * `core.nix:modules/pi` does, is left out, since it would take a place
 * among a cell's subjects and route nothing.
 *
 * The led areas are worked out each time the history is written, under
 * its lock, and kept beside it in {@link LED_AREAS_FILE}, so a peer
 * reading its quest's at every refresh reads a few kilobytes rather
 * than a month of landings. Each lead is kept with when it lapses if
 * nothing more lands, its second-newest landing's time and
 * {@link LED_WITHIN_MS} on, so a quiet day's file stops saying a lead
 * the window has let go rather than saying it until the next landing.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../internal/record.ts";
import { writeWhole } from "../internal/write-whole.ts";
import type { KeptLanding } from "./landing-history.ts";
import { routingWords } from "./need-route.ts";
import { MOST_SUBJECTS } from "./subjects.ts";

/** The led areas' file name, beside the landing history. */
export const LED_AREAS_FILE = "led-areas.json";

/** How long a landing counts toward leading an area. */
export const LED_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a landing takes to weigh half as much. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** The share of an area's most weight a quest needs to lead it too. */
export const LEADS_AT = 0.5;

/** The fewest landings in an area that can lead it. */
export const FEWEST_LANDINGS = 2;

/** The largest led areas file read: anything past this is not one. */
const LARGEST_FILE = 1024 * 1024;

/** A quest's weight and landings in one area. */
interface Share {
	weight: number;
	/** When each landing counted landed, newest first once all are in. */
	at: number[];
}

/** An area a quest led, as a subject, and when it lapses if nothing more lands. */
export interface Lead {
	readonly subject: string;
	/** Epoch milliseconds. */
	readonly until: number;
}

/** The subject an area of `repo` is said as: the repository's name, then the area. */
function subjectOf(repo: string, area: string): string {
	return `${repo.slice(repo.lastIndexOf("/") + 1)}:${area}`;
}

/** The areas a kept landing names, read as the strings among whatever it holds. */
function areasNamed(areas: unknown): string[] {
	return Array.isArray(areas)
		? areas.filter((area): area is string => typeof area === "string")
		: [];
}

/**
 * The areas each quest led in `landings` at `now`, as subjects with when
 * each lapses, those it leads by most weight first, at most a cell's
 * {@link MOST_SUBJECTS}. A quest leading none is left out.
 */
export function ledAreas(
	landings: readonly KeptLanding[],
	now: number,
): Record<string, Lead[]> {
	const shares = new Map<string, Map<string, Share>>();
	for (const landing of landings) {
		const { repo } = landing;
		const quest = landing.proposedBy;
		if (!(typeof quest === "string" && quest && typeof repo === "string")) {
			continue;
		}
		const at = Date.parse(landing.at);
		const age = now - at;
		if (!(age >= 0 && age < LED_WITHIN_MS)) continue;
		const weight = 2 ** (-age / HALF_LIFE_MS);
		for (const area of new Set(areasNamed(landing.areas))) {
			const subject = subjectOf(repo, area);
			if (routingWords(subject).length === 0) continue;
			const byQuest = shares.get(subject) ?? new Map<string, Share>();
			const share = byQuest.get(quest) ?? { weight: 0, at: [] };
			share.weight += weight;
			share.at.push(at);
			byQuest.set(quest, share);
			shares.set(subject, byQuest);
		}
	}
	const led = new Map<string, (Lead & { weight: number })[]>();
	for (const [subject, byQuest] of shares) {
		const most = Math.max(...[...byQuest.values()].map((one) => one.weight));
		for (const [quest, { weight, at }] of byQuest) {
			if (at.length < FEWEST_LANDINGS || weight < LEADS_AT * most) continue;
			const lapsing = at.sort((a, b) => b - a)[FEWEST_LANDINGS - 1] ?? now;
			led.set(quest, [
				...(led.get(quest) ?? []),
				{ subject, weight, until: lapsing + LED_WITHIN_MS },
			]);
		}
	}
	return Object.fromEntries(
		[...led].map(([quest, leads]) => [
			quest,
			leads
				.sort(
					(a, b) => b.weight - a.weight || a.subject.localeCompare(b.subject),
				)
				.slice(0, MOST_SUBJECTS)
				.map(({ subject, until }) => ({ subject, until })),
		]),
	);
}

/** Write the areas each quest led in `landings` beside them in `dir`. */
export function keepLedAreas(
	dir: string,
	landings: readonly KeptLanding[],
	now: number,
): void {
	const file = {
		v: 2,
		at: new Date(now).toISOString(),
		quests: ledAreas(landings, now),
	};
	writeWhole(join(dir, LED_AREAS_FILE), `${JSON.stringify(file)}\n`);
}

/**
 * The file as last read, so an unchanged one isn't parsed again: each
 * write renames a new file in, so its inode says a change, and its
 * time and size say one written in place.
 */
let lastRead:
	| { path: string; stamp: string; quests: Record<string, unknown> }
	| undefined;

/** What the led areas file at `path` holds by quest, or nothing when it is missing or isn't one. */
function questsAt(path: string): Record<string, unknown> {
	try {
		const seen = statSync(path);
		const { ino, mtimeMs, size } = seen;
		if (!seen.isFile() || size > LARGEST_FILE) return {};
		const stamp = `${ino}:${mtimeMs}:${size}`;
		if (lastRead?.path === path && lastRead.stamp === stamp) {
			return lastRead.quests;
		}
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		const quests =
			typeof value === "object" &&
			value !== null &&
			"quests" in value &&
			typeof value.quests === "object" &&
			value.quests !== null
				? (value.quests as Record<string, unknown>)
				: {};
		lastRead = { path, stamp, quests };
		return quests;
	} catch {
		// None written yet, or one being replaced as it was read: the
		// quest says no led areas until the next refresh reads it whole.
		return {};
	}
}

/**
 * The areas `quest` leads at `now`, as the file beside the landing
 * history in `dir` says, leaving out a lead that has lapsed since it was
 * written. A bare subject, as a file from before leads lapsed holds, is
 * read as one still led.
 */
export function ledAreasAt(
	dir: string,
	quest: string,
	now = Date.now(),
): string[] {
	const leads = questsAt(join(dir, LED_AREAS_FILE))[quest];
	if (!Array.isArray(leads)) return [];
	return leads.flatMap((lead: unknown) => {
		if (typeof lead === "string") return [lead];
		return isRecord(lead) &&
			typeof lead.subject === "string" &&
			typeof lead.until === "number" &&
			lead.until > now
			? [lead.subject]
			: [];
	});
}
