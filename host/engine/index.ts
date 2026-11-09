/** The shared host's conversation ownership, the host's own pi and, later, its engine adapter. */
export {
	HOST_SEAMS,
	type HostPi,
	type HostPiModules,
	HostPiRefused,
	type HostSeam,
	hostPiFiles,
	loadHostPi,
} from "./host-pi.ts";
export {
	HARNESS_SETTINGS_VARIABLE,
	type HarnessRequest,
	type HarnessTraits,
	harnessSettings,
} from "./harness-settings.ts";
export {
	type ConversationIdentity,
	type ConversationRegistration,
	HOST_RELOAD_ONTO,
	SessionHost,
} from "./session-host.ts";
