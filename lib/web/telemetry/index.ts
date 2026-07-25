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
