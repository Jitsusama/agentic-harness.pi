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
} from "./devices.ts";
export {
	type Divergence,
	divergences,
	type EmulationState,
	type MediaFeature,
	mediaFeaturesOf,
	mergeEmulation,
	type ObservedEnvironment,
	refusedFeature,
	unsupportedFields,
	type VisionDeficiency,
	withoutFeature,
} from "./emulation.ts";
export { ENVIRONMENT_PROBE } from "./probes.ts";
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
} from "./shaping.ts";
export { renderStatus, type SessionStatus } from "./status.ts";
export {
	type CookieRecord,
	captureState,
	readState,
	renderStorage,
	type SavedState,
	type StorageSnapshot,
} from "./storage.ts";
export { chooseTab, renderTabs, type TabRecord } from "./tabs.ts";
export { renderEnvironment } from "./view.ts";
