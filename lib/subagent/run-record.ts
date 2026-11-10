/**
 * Run records: what a fleet or a review round is doing, said for the
 * launcher, which shows each session's runs through the mesh's node.
 *
 * The launcher found runs by walking every participant's folder and
 * tying each to a session by its parent's pid, which a restart, a park
 * or a rollover breaks. So the session that starts a run says it: one
 * file per run in the mesh's `runs/` folder, the node's folder source,
 * holding the run under `runs` as the node's `--serves` reads it, keyed
 * by an id unique on the machine. Each file is rebuilt from what the
 * supervisor keeps for every member (its request, lease and result) on
 * a short clock while the run goes on, and written only when it says
 * something new, so a run that outlives its call, as a detached round
 * does, still says how it ended. A file goes a day after its run ends.
 *
 * Bookkeeping must not cost a run: nothing here throws at its caller.
 */

import { randomBytes } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../internal/paths.ts";
import { isRecord } from "../internal/record.ts";
import { ReviewerArtifactsStore } from "./artifacts.ts";
import { safeSegment } from "./errno.ts";

/** What kind of run: a fleet, or a kind of review round. */
export type RunKind =
	| "fleet"
	| "council"
	| "judge"
	| "critique"
	| "audit"
	| "stack";

/** Where a run stands: going on, or how it ended. */
export type RunState = "running" | "done" | "failed" | "stopped";

/** Tokens, in gen_ai's names, as presence's usage says them. */
export interface RunTokens {
	readonly "gen_ai.usage.input_tokens": number;
	readonly "gen_ai.usage.output_tokens": number;
	readonly "gen_ai.usage.cache_read.input_tokens": number;
	readonly "gen_ai.usage.cache_creation.input_tokens": number;
}

/** One member of a run, as its record says it. */
export interface RunMember {
	readonly id: string;
	/** queued, running, or the state its supervisor ended it in. */
	readonly state: string;
	/** As provider/id, when it names one. */
	readonly model?: string;
	readonly persona?: string;
	/** Once it has ended, since the supervisor counts it then. */
	readonly usage?: RunTokens;
	readonly "pi.cost.usd"?: number;
	/** Where its answer is kept, once it has one. */
	readonly answer: string;
	readonly since?: string;
	readonly ended?: string;
}

/** A run as its record says it. */
export interface RunRecord {
	/** Unique on the machine: the store it runs in, and its run id. */
	readonly id: string;
	readonly kind: RunKind;
	/**
	 * The kind again, under a name the node leaves alone: it serves every
	 * record with `kind` set to its own, "run", so on 7 November the
	 * launcher read all 47 of optimus's runs (36 fleets, 10 councils and
	 * a judge on disk) as plain runs.
	 */
	readonly "run.kind": RunKind;
	/** The session that started it, by id. */
	readonly parent: string;
	/** The change it reads, or what the fleet is, by its run id. */
	readonly about: string;
	readonly state: RunState;
	readonly since: string;
	readonly ended?: string;
	/** When it was last looked at. */
	readonly at: string;
	readonly members: readonly RunMember[];
	readonly "pi.cost.usd": number;
}

/** A member as the run's starter knows it, before reading its folder. */
export interface MemberAsked {
	readonly id: string;
	readonly model?: string;
	readonly persona?: string;
}

/** What the run's starter knows of it. */
export interface RunAsked {
	/** The store it runs in, which keeps run ids apart. */
	readonly store: "fleet" | "review";
	/** The folder its supervisor keeps its members' files under. */
	readonly artifacts: string;
	readonly runId: string;
	readonly kind: RunKind;
	readonly parent: string;
	readonly about: string;
	readonly since: Date;
}

/** How long a run's record stays once the run has ended. */
export const KEPT_MS = 24 * 60 * 60 * 1000;

/** How often a run going on is looked at. */
export const LOOK_MS = 5_000;

/** The states a lease holds while its member goes on. */
const GOING_ON = new Set(["starting", "running"]);

/** The states a member ends in that mean it answered. */
const ANSWERED = new Set(["complete", "soft-deadline"]);

/** The folder of run records, beside presence, which the node serves. */
export function runRecordsDir(): string {
	return join(stateDir("mesh-workflow"), "runs");
}

/** A run's record, read from what its members' supervisors keep. */
export async function runRecord(
	asked: RunAsked,
	members: readonly MemberAsked[],
	now: Date,
): Promise<RunRecord> {
	const store = new ReviewerArtifactsStore(asked.artifacts);
	const read = await Promise.all(
		members.map((member) =>
			memberOf(member, store.paths(asked.runId, member.id)),
		),
	);
	const state = stateOf(read);
	const ended =
		state === "running"
			? undefined
			: read
					.map((one) => one.ended ?? "")
					.sort()
					.at(-1) || now.toISOString();
	return {
		id: `${asked.store}.${asked.runId}`,
		kind: asked.kind,
		"run.kind": asked.kind,
		parent: asked.parent,
		about: asked.about,
		state,
		since: asked.since.toISOString(),
		...(ended ? { ended } : {}),
		at: now.toISOString(),
		members: read,
		"pi.cost.usd": read.reduce(
			(sum, one) => sum + (one["pi.cost.usd"] ?? 0),
			0,
		),
	};
}

/** A run going on, looked at until it ends. */
export interface RunWatch {
	/** Take in a member asked after the run began. */
	note(member: MemberAsked): void;
	/**
	 * Look once more, as the run's call returns. A member still queued
	 * then never started, so it is said as failed; one still running is
	 * looked at until its supervisor says how it ended.
	 */
	end(): Promise<void>;
}

/**
 * Say a run in its record, from now until it ends: at once, then every
 * LOOK_MS while any member goes on, written only when it changed.
 */
export function watchRun(
	asked: RunAsked,
	members: readonly MemberAsked[],
	options: { dir?: string; everyMs?: number; now?: () => Date } = {},
): RunWatch {
	const dir = options.dir ?? runRecordsDir();
	const now = options.now ?? (() => new Date());
	const known = new Map(members.map((one) => [one.id, one]));
	let said = "";
	let ended = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let looking: Promise<void> = Promise.resolve();
	const look = () => {
		looking = looking.then(async () => {
			try {
				const record = await runRecord(asked, [...known.values()], now());
				const final = ended ? unstartedFailed(record, now()) : record;
				// Written when what it says moves, not when it was looked at.
				const { at: _looked, ...saying } = final;
				const text = JSON.stringify(saying);
				if (text !== said) {
					said = text;
					await writeRunRecord(dir, final, now());
				}
				if (final.state !== "running") stop();
			} catch {
				// Bookkeeping must not cost a run; the next look tries again,
				// and a run whose record will not write still runs.
			}
		});
		return looking;
	};
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const start = () => {
		if (timer) return;
		timer = setInterval(() => void look(), options.everyMs ?? LOOK_MS);
		timer.unref?.();
	};
	start();
	void look();
	return {
		note(member) {
			if (known.has(member.id)) return;
			known.set(member.id, member);
			start();
			void look();
		},
		async end() {
			ended = true;
			await look();
		},
	};
}

/**
 * The record with every member that never started said as failed, for
 * a run whose call has returned, and ended when nothing else goes on.
 */
function unstartedFailed(record: RunRecord, now: Date): RunRecord {
	if (record.state !== "running") return record;
	const members = record.members.map((one) =>
		one.state === "queued" ? { ...one, state: "failed" } : one,
	);
	const state = stateOf(members);
	return {
		...record,
		members,
		state,
		...(state === "running" ? {} : { ended: now.toISOString() }),
	};
}

/**
 * Write a run's record whole, as the node's folder source reads it, and
 * let go of records whose runs ended more than KEPT_MS ago, or that
 * nobody has looked at for as long, since a session that ended under
 * its run never says how the run ended.
 */
export async function writeRunRecord(
	dir: string,
	record: RunRecord,
	now: Date,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${safeSegment(record.id)}.json`);
	// Named by chance rather than by pid: the write runs across awaits,
	// and a host's conversations share one pid.
	const partial = `${file}.${randomBytes(4).toString("hex")}.part`;
	await writeFile(partial, `${JSON.stringify({ v: 1, runs: [record] })}\n`);
	await rename(partial, file);
	await letGoOfEnded(dir, now);
}

async function letGoOfEnded(dir: string, now: Date): Promise<void> {
	for (const name of await readdir(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const last = lastSaid(await readJson(path));
		if (last !== undefined && now.getTime() - last > KEPT_MS) {
			await rm(path, { force: true });
		}
	}
}

/** When a record's run ended, or else when it was last looked at. */
function lastSaid(body: unknown): number | undefined {
	const runs = fieldOf(body, "runs");
	const run: unknown = Array.isArray(runs) ? runs[0] : undefined;
	const when = stringIn(run, "ended") ?? stringIn(run, "at");
	const at = when === undefined ? Number.NaN : Date.parse(when);
	return Number.isFinite(at) ? at : undefined;
}

/** A member as its supervisor's files say it, or queued with none. */
async function memberOf(
	member: MemberAsked,
	paths: { requestPath: string; leasePath: string; resultPath: string },
): Promise<RunMember> {
	const [request, lease, result] = await Promise.all([
		readJson(paths.requestPath),
		readJson(paths.leasePath),
		readJson(paths.resultPath),
	]);
	const model = modelIn(request) ?? member.model;
	const supervised = numberIn(lease, "supervisorStartedAt");
	const base = {
		id: member.id,
		...(model ? { model } : {}),
		...(member.persona ? { persona: member.persona } : {}),
		answer: paths.resultPath,
		...(supervised === undefined
			? {}
			: { since: new Date(supervised).toISOString() }),
	};
	// The result first, then a lease its supervisor ended without one,
	// as one stopped before its child answered.
	const leased = stringIn(lease, "state");
	const ended =
		stringIn(result, "state") ??
		(leased === undefined || GOING_ON.has(leased) ? undefined : leased);
	if (ended === undefined) {
		// Started once its request is written, which its parent does
		// before spawning the supervisor that writes its lease.
		const started = request !== undefined || lease !== undefined;
		return { ...base, state: started ? "running" : "queued" };
	}
	// What its calls took, as the supervisor counted them in its result.
	const usage = fieldOf(result, "usage");
	const tokens = fieldOf(usage, "tokens");
	const cost = numberIn(fieldOf(usage, "cost"), "total");
	const completed =
		stringIn(result, "completedAt") ?? stringIn(lease, "completedAt");
	return {
		...base,
		state: ended,
		...(isRecord(tokens) ? { usage: tokensOf(tokens) } : {}),
		...(cost === undefined ? {} : { "pi.cost.usd": cost }),
		...(completed ? { ended: completed } : {}),
	};
}

/** A supervisor's token counts, in gen_ai's names. */
function tokensOf(tokens: Record<string, unknown>): RunTokens {
	return {
		"gen_ai.usage.input_tokens": numberIn(tokens, "input") ?? 0,
		"gen_ai.usage.output_tokens": numberIn(tokens, "output") ?? 0,
		"gen_ai.usage.cache_read.input_tokens": numberIn(tokens, "cacheRead") ?? 0,
		"gen_ai.usage.cache_creation.input_tokens":
			numberIn(tokens, "cacheWrite") ?? 0,
	};
}

/** Where a run stands, from where its members do. */
function stateOf(members: readonly { state: string }[]): RunState {
	if (
		members.some((one) => one.state === "queued" || one.state === "running")
	) {
		return "running";
	}
	if (members.some((one) => one.state === "cancelled")) return "stopped";
	return members.some((one) => ANSWERED.has(one.state)) ? "done" : "failed";
}

/** The model a member's pi was started on, from its request's words. */
function modelIn(request: unknown): string | undefined {
	const args = fieldOf(request, "args");
	if (!Array.isArray(args)) return undefined;
	const at = args.indexOf("--model");
	const model = at >= 0 ? args[at + 1] : undefined;
	return typeof model === "string" ? model : undefined;
}

function fieldOf(body: unknown, key: string): unknown {
	return isRecord(body) ? body[key] : undefined;
}

function stringIn(body: unknown, key: string): string | undefined {
	const value = fieldOf(body, key);
	return typeof value === "string" ? value : undefined;
}

function numberIn(body: unknown, key: string): number | undefined {
	const value = fieldOf(body, key);
	return typeof value === "number" ? value : undefined;
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		// A file not written yet, or half written, says nothing; the next
		// look reads it whole.
		return undefined;
	}
}
