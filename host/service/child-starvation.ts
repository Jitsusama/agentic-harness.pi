/**
 * Whether a child past its time, which nobody waits on, is starved by a
 * busy machine or stuck: judged first as it listens, then again as it
 * builds its conversation before it answers its watch, since a starved
 * child does both as slowly. Starved, it is waited on rather than
 * stopped, since starting it again on the same machine would starve the
 * same way and throw its start away.
 */

/**
 * The share of a waiting time a starved child gains in CPU over one, at
 * the least: 150 ms a minute. One that took 142 s to resume on 22
 * November gained about 0.9% of a core over its whole wait, an average
 * of one child, which a single listen time of it may have fallen below;
 * 1% would have given it up. One that gains less waits on a lock, the
 * disk or the network, with only its timers ticking, so it is taken as
 * stuck rather than starved, and the next wake starts it again.
 */
const STALLED_SHARE = 0.0025;

/** What a child is judged on, as its judgement says it. */
export interface Doing {
	/** What it hasn't done, as said as it is first waited on: "hasn't listened". */
	readonly hasnt: string;
	/** What it did, as said once it does it starved: "listened". */
	readonly did: string;
	/** What the CPU it spent counts from, as said with it: "" or " since it listened". */
	readonly since: string;
	/** The error it is given up with, after `within` ms, with what says why. */
	failed(within: number, why: string): Error;
}

/** A child past its time, judged each time `until` passes. */
export interface Starvation {
	/** When it is next judged. */
	readonly until: number;
	/**
	 * Judge it now that `until` has passed: wait on, moving `until`, or
	 * throw `doing`'s error saying why it is given up.
	 */
	overdue(): Promise<void>;
	/** Say, when it waited on it starved, that it did what it was judged on. */
	done(): void;
}

/** What a judgement of one child is given. */
interface Judged {
	/** The child's unit, as its lines name it. */
	readonly unit: string;
	readonly doing: Doing;
	/** When its wait began, and how long it had before it is judged. */
	readonly began: number;
	readonly ms: number;
	/** When it is given up, however starved. */
	readonly ceiling: number;
	/** The CPU it may spend from where its count begins and still be starved. */
	readonly cpuMs: number;
	/** How often systemd is asked again. */
	readonly everyMs: number;
	/** The CPU its unit has spent, in ms, or undefined when systemd won't say. */
	spent(): Promise<number | undefined>;
	/** What the CPU it spent counts from, as systemd said it then; none when left out. */
	readonly from?: number;
	say?(line: string): void;
}

/**
 * Judge a child that hasn't done what `doing` says by its time: one
 * with little CPU is starved by a busy machine rather than stuck, and
 * waited on until it has spent its CPU, gains less than STALLED_SHARE of
 * a whole waiting time in one, or `ceiling` comes. A systemd too loaded
 * to say its CPU at first is asked again, for one more waiting time, so
 * one that never says it, with no CPU account, is given up after two.
 */
export function starvation(judged: Judged): Starvation {
	const { unit, doing, began, ms, ceiling, cpuMs, everyMs } = judged;
	let until = began + ms;
	let starved = false;
	/** When an unsaid first CPU stops being asked again. */
	const unsaidUntil = began + 2 * ms;
	let askedAgain = false;
	/** The CPU it last said it had spent. */
	let spentLast: number | undefined;
	/** The CPU it had when it last grew by enough, and when that was. */
	let grewFrom: number | undefined;
	let grewAt = began;
	const enough = ms * STALLED_SHARE;
	/** The CPU spent since its count began. */
	async function spentSince(): Promise<number | undefined> {
		const total = await judged.spent();
		if (total === undefined) return undefined;
		return total - Math.min(total, judged.from ?? 0);
	}
	return {
		get until() {
			return until;
		},
		async overdue() {
			const spent = await spentSince();
			const now = Date.now();
			if (spent !== undefined) {
				spentLast = spent;
				if (grewFrom === undefined || spent - grewFrom >= enough) {
					grewFrom = spent;
					grewAt = now;
				}
			}
			// Once it is waited on, a systemd too loaded to say leaves it
			// waiting: a loaded machine is what starves it.
			const known = spent ?? (starved ? spentLast : undefined);
			const stillStarved = known !== undefined && known < cpuMs;
			// One that gains next to no CPU for a whole waiting time waits on
			// a lock, the disk or the network, not on the machine.
			const stalled = starved && spent !== undefined && now - grewAt >= ms;
			const gained = spent === undefined ? 0 : spent - (grewFrom ?? spent);
			if (spent === undefined && !starved && now < unsaidUntil) {
				// A systemd too loaded to say at first is asked again, as
				// whether it has gone is.
				until = Math.min(unsaidUntil, now + everyMs);
				askedAgain = true;
				return;
			}
			if (stillStarved && !stalled && now < ceiling) {
				if (!starved)
					judged.say?.(
						`${unit} ${doing.hasnt} in ${ms} ms, but has had only ${known} ms of CPU${doing.since}: it is starved rather than stuck, so it is waited on`,
					);
				starved = true;
				// Asked again each second, as whether it has gone is.
				until = Math.min(ceiling, now + everyMs);
				return;
			}
			const cpu =
				known === undefined ? "" : `, with ${known} ms of CPU${doing.since}`;
			const share = gained === 0 ? "none" : `only ${gained} ms`;
			const stuck = stalled
				? `, ${share} of it in the last ${now - grewAt} ms: it is stuck rather than starved`
				: "";
			// One given up at the ceiling is said at it; one given up sooner,
			// starved or asked again, at the time it took.
			const within =
				starved && stillStarved && !stalled
					? ceiling - began
					: starved || askedAgain
						? now - began
						: ms;
			throw doing.failed(within, `${cpu}${stuck}`);
		},
		done() {
			if (starved)
				judged.say?.(
					`${unit} ${doing.did} after ${Date.now() - began} ms, starved, having had ${spentLast ?? "an unknown"} ms of CPU${doing.since}`,
				);
		},
	};
}
