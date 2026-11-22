/**
 * What tells a repeated start from a new one, shared by a host and the
 * pi that asks it: how long a repeat is answered and what it is matched
 * by. Kept apart from repeats.ts, which refuses through the host's
 * protocol and so loads zod, since every pi loads the spawn that reads
 * these at start and zod only on its first request to a host.
 */
import { STAGE_VARIABLE } from "../../lib/internal/fence/fence-stage.ts";

/**
 * How long, in ms, a settled start's answer is kept for a repeat: long
 * past a spawn's patience and a person's retry, and short enough that
 * the host keeps only a few.
 */
export const REPEAT_WINDOW_MS = 15 * 60_000;

/** What a repeat is told by, and what it is matched against. */
export type Repeatable = {
	readonly id: string;
	readonly [field: string]: unknown;
};

/**
 * What a request asks for, without its id or the host it expects, so a
 * repeat sent after a restart of the requester still matches; keys in
 * order, so two spellings of one request match. A requester keeping its
 * id across a retry compares by it too (spawn-pending.ts). The fence's
 * first-stage token's value is left out too: each spawn lists a new one,
 * and a repeat is answered with the first's conversation, which already
 * holds the first's (fence-stage.ts). Whether there is one stays in, so
 * a retry that gains the fence is never answered with an unfenced one.
 */
export function fingerprint(request: Repeatable): string {
	const { id: _id, expectedHost: _expected, env, ...rest } = request;
	const kept = isPlain(env) ? withStageUnvalued(env) : env;
	const asked = kept === undefined ? rest : { ...rest, env: kept };
	return JSON.stringify(asked, (_key, value: unknown) =>
		isPlain(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
				)
			: value,
	);
}

/** `env` with the stage's token, when it holds one, said without its value. */
function withStageUnvalued(
	env: Record<string, unknown>,
): Record<string, unknown> {
	return STAGE_VARIABLE in env ? { ...env, [STAGE_VARIABLE]: "staged" } : env;
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
