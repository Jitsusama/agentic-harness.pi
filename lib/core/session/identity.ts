/** Session identity and the ambient context for library calls without a ctx. */
import { AsyncLocalStorage } from "node:async_hooks";

/** Only the part of pi's context needed to identify a conversation. */
export interface SessionContext {
	readonly sessionManager: { getSessionId(): string };
}

/** An explicit context or key, preferred to ambient state whenever available. */
export type SessionRef = SessionContext | string;

const AMBIENT_KEY = Symbol.for("agentic-harness.session.ambient.v1");

function ambient(): AsyncLocalStorage<string | undefined> {
	const holder = globalThis as {
		[AMBIENT_KEY]?: AsyncLocalStorage<string | undefined>;
	};
	holder[AMBIENT_KEY] ??= new AsyncLocalStorage();
	return holder[AMBIENT_KEY];
}

/** pi's session id, shared by the mirror file, the mesh and its host. */
export function sessionKeyOf(ctx: SessionContext): string {
	return ctx.sessionManager.getSessionId();
}

/** The conversation whose hook or tool is running, if the host wrapped it. */
export function ambientSession(): string | undefined {
	return ambient().getStore();
}

/** Run every hook, tool and runner entry through this, including callbacks. */
export function withSession<T>(sessionId: string | undefined, fn: () => T): T {
	return ambient().run(sessionId, fn);
}

/** A hosted caller omitted its conversation rather than sharing state silently. */
export class NoSessionInHost extends Error {
	constructor() {
		super(
			"No session in host: pass a session context or wrap the call in withSession",
		);
		this.name = "NoSessionInHost";
	}
}

/** Resolve an explicit or ambient session, refusing an unkeyed hosted call. */
export function requireSession(ref?: SessionRef): string {
	const key =
		typeof ref === "string" ? ref : ref ? sessionKeyOf(ref) : ambientSession();
	if (!key) throw new NoSessionInHost();
	return key;
}

/** The conversation folder, not the host's working directory. */
export function sessionCwd(ctx: { readonly cwd: string }): string {
	return ctx.cwd;
}
