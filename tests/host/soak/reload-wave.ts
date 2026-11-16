/**
 * A wave of reloads onto a moved install, as the soak's --reload-wave
 * runs one: every awake conversation reloaded through its host, one at a
 * time, as reload-workflow's follower reloads each once its install
 * moves. The first reload onto the new version loads its code afresh;
 * each after it finds that code already loaded. On 16 November both
 * hosts' loops held 5 s in the second one reloaded, and the loop
 * witness, which speaks only past 5 s, couldn't say what a reload holds
 * it for when it holds it less, so each reload's own loop is weighed.
 */
import { type Spread, spreadOf } from "./report.ts";

/** The loop hold item 9 bars, in ms: no line held over a second. */
export const LOOP_BAR_MS = 1000;

/** The share of a run's checkpoints passed before the wave reloads. */
const WAVE_SHARE = 3 / 4;

/** One conversation's reload in the wave, as the soak timed it. */
export interface WaveReload {
	/** The conversation, by its place in the run. */
	readonly conversation: number;
	/** From its reload asked to its screen saying it reloaded, in ms. */
	readonly ms: number;
	/** The most the host's loop ran late while it reloaded, in ms. */
	readonly loopMaxMs: number;
}

/** What a wave cost: its first reload apart, and the rest summed. */
export interface WaveFigures {
	readonly count: number;
	/** The reload that loaded the new version's code, unless none ran. */
	readonly first?: { readonly ms: number; readonly loopMaxMs: number };
	/** Every reload after the first. */
	readonly rest: {
		readonly ms: Spread;
		readonly loopMaxMs: Spread;
		readonly mostLoopMaxMs: number;
	};
	/** How many reloads held the loop past LOOP_BAR_MS. */
	readonly overBar: number;
}

/**
 * The checkpoint, counted from one, at which a run of `checkpoints`
 * reloads every conversation: three quarters through, after the mid-run
 * restart, leaving checkpoints after it to weigh what the old version
 * left behind.
 */
export function waveCheckpoint(checkpoints: number): number {
	return Math.max(1, Math.ceil(checkpoints * WAVE_SHARE));
}

/** What `reloads`, in the order they ran, cost. */
export function waveOf(reloads: readonly WaveReload[]): WaveFigures {
	const [first, ...rest] = reloads;
	const loops = rest.map((one) => one.loopMaxMs);
	return {
		count: reloads.length,
		...(first ? { first: { ms: first.ms, loopMaxMs: first.loopMaxMs } } : {}),
		rest: {
			ms: spreadOf(rest.map((one) => one.ms)),
			loopMaxMs: spreadOf(loops),
			mostLoopMaxMs: Math.max(0, ...loops),
		},
		overBar: reloads.filter((one) => one.loopMaxMs > LOOP_BAR_MS).length,
	};
}
