/**
 * The environment a page thinks it is running in: viewport,
 * media preferences, sight, locale and clock.
 *
 * The analysis here is capture-agnostic, so an observation
 * taken by another driver reads the same way.
 */

export {
	type DeviceCatalogue,
	type DeviceProfile,
	deviceEmulation,
	nearestDevices,
	noSuchDevice,
} from "./devices.js";
export {
	type Divergence,
	divergences,
	type EmulationState,
	type MediaFeature,
	mediaFeaturesOf,
	mergeEmulation,
	type ObservedEnvironment,
	unsupportedFields,
	type VisionDeficiency,
} from "./emulation.js";
export { ENVIRONMENT_PROBE } from "./probes.js";
export {
	matchesPattern,
	type NetworkRule,
	renderShaping,
	resolveThrottle,
	ruleFor,
	type ShapeAction,
	THROTTLE_PROFILES,
	type ThrottleConditions,
	throttleNames,
	throttleProfile,
} from "./shaping.js";
export { renderStatus, type SessionStatus } from "./status.js";
export {
	type CookieRecord,
	captureState,
	readState,
	renderStorage,
	type SavedState,
	type StorageSnapshot,
} from "./storage.js";
export { renderEnvironment } from "./view.js";
