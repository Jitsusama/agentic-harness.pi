/**
 * A conversation becoming another inside its runtime: pi's /new, /fork,
 * /resume and import. pi tears the old session down before it builds the
 * next, from inside the old conversation's own call, so this holds each
 * replacement to the host around pi's own steps: a target the host holds
 * already is refused before the teardown, what pi runs for the next session
 * runs as the next conversation, and once pi is done, or has failed past
 * the point of no return, the host is told which.
 */
import { resolve } from "node:path";
import { withSession } from "../../lib/core/session/index.ts";
import type { AgentSession, AgentSessionRuntime } from "./pi-session.ts";

/** What the host does around one runtime's replacements. */
export interface ReplacementHold {
	/** Refuse a session file the host holds already, before pi tears anything down. */
	refuse(sessionFile: string): void;
	/** pi runs another conversation in the runtime now, in place of previousId. */
	replaced(previousId: string): Promise<void>;
	/** pi disposed previousId's session and failed to build another. */
	lost(previousId: string, error: unknown): Promise<void>;
}

/** pi's runtime methods that replace its session. */
const REPLACING = [
	"newSession",
	"fork",
	"switchSession",
	"importFromJsonl",
] as const;

type Replacing = (typeof REPLACING)[number];

/** The options pi runs as the replaced session, by each method's options. */
const NEXT_SESSION_CALLBACKS = ["setup", "withSession"] as const;

/** What a replacing method answers. */
type Replaced = Promise<{ readonly cancelled: boolean }>;

/**
 * Hold a runtime's replacements to the host, on this runtime alone: each
 * replacing method, setRebindSession and setBeforeSessionInvalidate are
 * shadowed on the instance, so pi's InteractiveMode and an extension's
 * command, which both call the runtime, go through them.
 */
export function holdReplacements(
	runtime: AgentSessionRuntime,
	hold: ReplacementHold,
): void {
	const replacement = { torn: false };
	let invalidating: (() => void) | undefined;
	runtime.setBeforeSessionInvalidate(() => {
		replacement.torn = true;
		invalidating?.();
	});
	shadow(runtime, "setBeforeSessionInvalidate", (callback?: () => void) => {
		invalidating = callback;
	});
	const setRebind = runtime.setRebindSession.bind(runtime);
	shadow(
		runtime,
		"setRebindSession",
		(rebind?: (session: AgentSession) => Promise<void>) =>
			setRebind(
				rebind &&
					((session: AgentSession) =>
						withSession(session.sessionId, () => rebind(session))),
			),
	);
	for (const name of REPLACING) {
		const original: unknown = Reflect.get(runtime, name);
		if (typeof original !== "function") continue;
		shadow(runtime, name, async (...args: unknown[]): Replaced => {
			refuseHeld(hold, name, args);
			const previousId = runtime.session.sessionId;
			replacement.torn = false;
			let result: Awaited<Replaced>;
			try {
				result = await Reflect.apply(
					original,
					runtime,
					asNextSession(runtime, name, args),
				);
			} catch (error) {
				await settle(runtime, hold, previousId, replacement.torn, error);
				throw error;
			}
			await settle(runtime, hold, previousId, replacement.torn);
			return result;
		});
	}
}

/** Put a function on the runtime instance in place of its prototype's. */
function shadow(
	runtime: AgentSessionRuntime,
	name: string,
	value: (...args: never[]) => unknown,
): void {
	Object.defineProperty(runtime, name, {
		configurable: true,
		writable: true,
		value,
	});
}

/** A switch or import names a file; one the host holds is refused while nothing is torn down. */
function refuseHeld(
	hold: ReplacementHold,
	name: Replacing,
	args: readonly unknown[],
): void {
	const [target] = args;
	if (
		(name === "switchSession" || name === "importFromJsonl") &&
		typeof target === "string"
	)
		hold.refuse(resolve(target));
}

/** Tell the host what a replacement left: another conversation, none, or the same one untouched. */
async function settle(
	runtime: AgentSessionRuntime,
	hold: ReplacementHold,
	previousId: string,
	torn: boolean,
	error?: unknown,
): Promise<void> {
	if (runtime.session.sessionId !== previousId) await hold.replaced(previousId);
	else if (torn)
		await hold.lost(
			previousId,
			error ?? new Error("pi disposed the session and built no other"),
		);
}

/**
 * The arguments with what a caller asks pi to run on the replaced session
 * run as that session's conversation, rather than as the one that asked.
 */
function asNextSession(
	runtime: AgentSessionRuntime,
	name: Replacing,
	args: readonly unknown[],
): unknown[] {
	const at = name === "newSession" ? 0 : 1;
	const options: unknown = args[at];
	const next = [...args];
	if (typeof options !== "object" || options === null) return next;
	const wrapped: Record<string, unknown> = { ...options };
	for (const key of NEXT_SESSION_CALLBACKS) {
		const callback: unknown = wrapped[key];
		if (typeof callback !== "function") continue;
		wrapped[key] = (...callbackArgs: unknown[]) =>
			withSession(runtime.session.sessionId, () =>
				Reflect.apply(callback, undefined, callbackArgs),
			);
	}
	next[at] = wrapped;
	return next;
}
