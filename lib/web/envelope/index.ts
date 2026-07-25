/**
 * The shared envelope: how every list-shaped answer is
 * windowed, budgeted and, when it outgrows a response,
 * diverted to disk.
 */

export { type ArtifactOptions, withArtifact } from "./artifacts.js";
export {
	DEFAULT_BUDGET_BYTES,
	DEFAULT_LIMIT,
	type ListArgs,
	type Paged,
	type PageShape,
	paginate,
} from "./paged.js";
