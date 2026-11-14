/**
 * A hosted conversation with no screen, bound as pi's RPC mode binds
 * one: its extensions get no interface, and what they ask of pi's
 * command context (a new session, a fork, a reload, an end) goes to the
 * runtime or the host that holds it.
 */
import type { AgentSessionRuntime } from "./pi-session.ts";
import type { SessionHost } from "./session-host.ts";

/** What pi says of an error an extension threw, as its runner reports it. */
export interface ExtensionFailure {
	readonly extensionPath: string;
	readonly event: string;
	readonly error: string;
	readonly stack?: string;
}

/**
 * The journal's line for an extension's error: which extension, in which
 * event, and the extension's own stack when pi kept it, since a stack made
 * here would only say where the host passed it on.
 */
export function extensionErrorLine(failure: ExtensionFailure): string {
	const where = `Extension error (${failure.extensionPath}, ${failure.event})`;
	return `${where}: ${failure.stack ?? failure.error}`;
}

/** Bind a conversation's extensions with no interface, as pi's RPC mode does; the engine binds again after each replacement. */
export async function bindHeadless(
	runtime: AgentSessionRuntime,
	host: Pick<SessionHost, "close" | "reload">,
	report: (error: unknown) => void,
): Promise<void> {
	const session = runtime.session;
	const sessionId = session.sessionId;
	await session.bindExtensions({
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (next) => runtime.newSession(next),
			fork: (entryId, next) => runtime.fork(entryId, next),
			navigateTree: (targetId, next) =>
				runtime.session.navigateTree(targetId, next),
			switchSession: (path, next) => runtime.switchSession(path, next),
			reload: () =>
				host.reload(runtime.session.sessionId, {
					reason: "an extension asked",
				}),
		},
		shutdownHandler: () => {
			host
				.close(sessionId, "an extension ended the conversation")
				.catch(report);
		},
		onError: (error) => report(extensionErrorLine(error)),
	});
}
