/**
 * What the write guard does with one tool call: finds the writes in it,
 * the stops standing over them, and refuses those a live stop holds.
 * A stop still in shadow refuses nothing; what it would have refused is
 * written down for Joel to read.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	covering,
	type HeadOf,
	type Held,
	type Here,
} from "../../lib/internal/pineapple/cover.ts";
import { changesRecords } from "../../lib/internal/pineapple/records.ts";
import {
	describeReach,
	type Standing,
} from "../../lib/internal/pineapple/stops.ts";
import {
	type GitFacts,
	settle,
	type Write,
	type WriteCall,
	writeInTool,
	writesInBash,
} from "../../lib/internal/pineapple/writes.ts";

/** What one call is judged with, so a test can stand in for the machine. */
export interface Judging {
	readonly standing: () => Standing;
	readonly git: GitFacts;
	readonly headOf: HeadOf;
	readonly here: () => Here;
	/** Where the work tool keeps its trees, for a tree named by key. */
	readonly trees: string;
	/** Where what a shadow stop would have refused is written. */
	readonly shadowLog: string;
	/** The safe word's records, which no agent changes. */
	readonly records: string;
	readonly now: () => Date;
}

/** A tool call as the guard reads it. */
export interface Call {
	readonly tool: string;
	readonly input: unknown;
	readonly cwd: string;
	readonly session: string;
}

/** What the guard says of a call: nothing, or why it is refused. */
export type Verdict = { readonly refuse: string } | undefined;

/**
 * Judge a call. Most calls are no write and cost nothing; a write reads
 * the stops folder, and asks git or the pull request's host only when a
 * stop standing needs it to tell the write apart.
 */
export async function judge(call: Call, judging: Judging): Promise<Verdict> {
	const changed = changesRecords(
		call.tool,
		call.input,
		call.cwd,
		judging.records,
	);
	if (changed !== undefined) return { refuse: changed };
	const calls = writesOf(call, judging.trees);
	if (calls.length === 0) return undefined;
	const { stops } = judging.standing();
	if (stops.length === 0) return undefined;
	const here = judging.here();
	const live: Array<{ write: Write; held: Held[] }> = [];
	for (const stated of calls) {
		const write = await settle(stated, judging.git);
		const held = await covering(write, stops, here, judging.headOf);
		const shadow = held.filter((one) => one.stop.shadow);
		if (shadow.length > 0) logShadow(judging, call, write, shadow);
		const enforced = held.filter((one) => !one.stop.shadow);
		if (enforced.length > 0) live.push({ write, held: enforced });
	}
	const first = live[0];
	return first ? { refuse: refusal(first.write, first.held) } : undefined;
}

function writesOf(call: Call, trees: string): WriteCall[] {
	if (call.tool === "bash") {
		const input = call.input as { command?: unknown } | null;
		return typeof input?.command === "string"
			? writesInBash(input.command, call.cwd)
			: [];
	}
	const write = writeInTool(call.tool, call.input, call.cwd, trees);
	return write ? [write] : [];
}

/** The refusal's words: what stopped it, what is held, who lifts it. */
export function refusal(write: Write, held: readonly Held[]): string {
	const lines = [
		`Joel's safe word holds this ${write.action}${target(write)}.`,
	];
	for (const { stop, reach, because } of held) {
		const who = stop.saidBy ? `${stop.saidBy} said` : "Someone said";
		const words = stop.words ? ` "${oneLine(stop.words)}"` : "";
		const where = stop.where ? ` (${stop.where})` : "";
		lines.push(
			`- ${who}${words}${where}, stopping ${describeReach(reach)}: ${because}.`,
		);
	}
	lines.push(
		"Only Joel resumes a stop, so leave this write until he does and carry on with other work: reads, builds, commits and edits in your own tree still go.",
		"If this write is outside what was stopped and the guard couldn't tell, name the change or repository it goes to, so it can.",
	);
	return lines.join("\n");
}

function target(write: Write): string {
	if (write.kind === "machine") return "";
	const repo = write.repo ?? "";
	if (write.pr !== undefined) return ` to ${repo}#${write.pr}`;
	if (write.branch !== undefined)
		return ` to ${write.branch}${repo ? ` of ${repo}` : ""}`;
	return repo ? ` to ${repo}` : "";
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > WORDS_SHOWN
		? `${flat.slice(0, WORDS_SHOWN - 3)}...`
		: flat;
}

/** How much of a stop's words a refusal quotes. */
const WORDS_SHOWN = 200;

function logShadow(
	judging: Judging,
	call: Call,
	write: Write,
	held: readonly Held[],
): void {
	const line = {
		at: judging.now().toISOString(),
		session: call.session,
		tool: call.tool,
		action: write.action,
		kind: write.kind,
		repo: write.repo ?? null,
		pr: write.pr ?? null,
		branch: write.branch ?? null,
		dir: write.dir ?? null,
		stops: held.map(({ stop, reach, because }) => ({
			id: stop.id,
			reach: describeReach(reach),
			because,
		})),
	};
	try {
		mkdirSync(dirname(judging.shadowLog), { recursive: true });
		appendFileSync(judging.shadowLog, `${JSON.stringify(line)}\n`);
	} catch {
		// A log that can't be written loses a shadow line, never a write:
		// in shadow nothing is refused either way.
	}
}

/**
 * The quest a session has loaded, then its parents, read from the quest
 * workflow's records: the session's record names its quest, and each
 * quest's README names its parent.
 */
export function questsOf(
	session: string,
	sessions: string,
	quests: string,
): string[] {
	const id = loadedQuestOf(session, sessions);
	return id === undefined ? [] : questChain(id, quests);
}

/** A quest, then its parents, upper-case, as their READMEs name them. */
export function questChain(quest: string, quests: string): string[] {
	const chain: string[] = [];
	let id: string | undefined = quest;
	while (id !== undefined && !chain.includes(id) && chain.length < DEEPEST) {
		chain.push(id.toUpperCase());
		id = parentOf(join(quests, id, "README.md"));
	}
	return chain;
}

/** How deep a quest's parents are followed, past any real tree. */
const DEEPEST = 16;

function loadedQuestOf(session: string, sessions: string): string | undefined {
	try {
		const record = JSON.parse(
			readFileSync(join(sessions, `${session}.json`), "utf8"),
		) as {
			quest?: unknown;
		} | null;
		return typeof record?.quest === "string" ? record.quest : undefined;
	} catch {
		// No record: the session has no quest loaded.
		return undefined;
	}
}

function parentOf(readme: string): string | undefined {
	try {
		const text = readFileSync(readme, "utf8");
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
		const parent = /^parent:\s*(\S+)\s*$/m.exec(front)?.[1];
		return parent && parent !== "null" ? parent : undefined;
	} catch {
		// No README: the walk stops at the last quest found.
		return undefined;
	}
}
