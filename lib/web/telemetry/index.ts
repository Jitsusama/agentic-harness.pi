/**
 * Telemetry: what the page did while nobody was looking.
 *
 * Buffers here are plain data structures over serializable
 * entries, so a record captured from CDP, from a fixture or
 * from another driver is read the same way.
 */

export {
	type BufferLimits,
	createRingBuffer,
	type Recorded,
	type RingBuffer,
} from "./buffer.js";
export {
	type BrowserLogged,
	browserEntry,
	type CallFrame,
	type ConsoleCalled,
	consoleEntry,
	consoleText,
	type ExceptionThrown,
	exceptionEntry,
	type LogEntry,
	type RemoteArg,
	type RemotePreview,
	type RemotePreviewProperty,
	renderArg,
} from "./console.js";
export { type Captured, renderLogs } from "./view.js";
