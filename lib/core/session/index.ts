/** Session identity, state and ownership on plain pi and shared hosts. */

export type { TickedOwner as SessionOwner } from "../../internal/process-ticks.ts";
export { launchHints, sessionEnv } from "./env.ts";
export {
	type Host,
	type HostedSession,
	type HostedState,
	type HostRegistry,
	type HostReloadRequest,
	hosted,
	installHost,
	isSessionStamp,
	type LaunchHints,
	SESSION_STAMP_EVENT,
	type SessionEnvironment,
	type SessionStamp,
} from "./host.ts";
export {
	ambientSession,
	NoSessionInHost,
	type SessionContext,
	type SessionRef,
	sessionCwd,
	sessionKeyOf,
	withSession,
} from "./identity.ts";
export { endSession, sessionOwner } from "./owner.ts";
export { hostRegistryPath } from "./registry.ts";
export {
	releaseSession,
	type SessionCell,
	sessionCell,
	sessionSlot,
} from "./slot.ts";
