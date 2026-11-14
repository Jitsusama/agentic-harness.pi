/** The shared host's conversation ownership, the host's own pi and, later, its engine adapter. */
export type {
	ConversationTraits,
	EngineKey,
	EngineOptions,
	EngineScreens,
	HostEngine,
	HostedView,
} from "./contract.ts";
export { createEngine, KEY_VARIABLES } from "./engine.ts";
export {
	HARNESS_SETTINGS_VARIABLE,
	type HarnessEngine,
	type HarnessRequest,
	type HarnessTraits,
	harnessSettings,
} from "./harness-settings.ts";
export {
	HOST_SEAMS,
	HOST_WANTED_SEAMS,
	type HostPi,
	type HostPiModules,
	HostPiRefused,
	type HostSeam,
	hostPiFiles,
	lackingSeams,
	loadHostPi,
} from "./host-pi.ts";
export type { StartupDiagnostic } from "./pi-session.ts";
export { HOST_READS } from "./process-env.ts";
export type { ConversationResources } from "./resources.ts";
export {
	type ConversationIdentity,
	type ConversationRegistration,
	HOST_RELOAD_ONTO,
	SessionHost,
} from "./session-host.ts";
