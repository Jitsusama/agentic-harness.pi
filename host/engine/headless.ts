/**
 * A hosted conversation with no screen, bound as pi's RPC mode binds
 * one: its extensions get no interface, and what they ask of pi's
 * command context (a new session, a fork, a reload, an end) goes to the
 * runtime or the host that holds it.
 */
import type { AgentSessionRuntime } from "./pi-session.ts";
import type { SessionHost } from "./session-host.ts";

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
		onError: (error) =>
			report(
				new Error(`Extension error (${error.extensionPath}): ${error.error}`),
			),
	});
}
