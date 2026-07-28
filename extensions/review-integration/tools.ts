/**
 * The tool surface, in one import.
 *
 * Each tool is registered by its own module under `tools/`,
 * because a registration carries its schema, its two renderers
 * and its execute body together and four of those in one file
 * reads as a wall. This barrel is what `index.ts` imports, so
 * the wiring there stays a table of contents rather than a list
 * of paths.
 */

export { registerDraftTool } from "./tools/draft.js";
export { registerReviewTool } from "./tools/read.js";
export { registerStackTool } from "./tools/stack.js";
export { registerThreadTool } from "./tools/thread.js";
