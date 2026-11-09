/**
 * The shared envelope: how every list-shaped answer is
 * windowed, budgeted and, when it outgrows a response,
 * diverted to disk.
 */

export { pathComponent } from "./naming.ts";
export {
	type BundleSink,
	DIR_MODE,
	diskSink,
	FILE_MODE,
} from "./sink.ts";
