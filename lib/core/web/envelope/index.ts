/**
 * The shared envelope: how every list-shaped answer is
 * windowed, budgeted and, when it outgrows a response,
 * diverted to disk.
 */

export { type ArtifactOptions, withArtifact } from "./artifacts.ts";
export { pathComponent } from "./naming.ts";
export {
	DEFAULT_BUDGET_BYTES,
	DEFAULT_LIMIT,
	type ListArgs,
	type Paged,
	type PageShape,
	paginate,
} from "./paged.ts";
export {
	BUNDLE_ROOT,
	type BundleSink,
	DIR_MODE,
	diskSink,
	FILE_MODE,
	LEGACY_BUNDLE_ROOTS,
	sessionDir,
} from "./sink.ts";
