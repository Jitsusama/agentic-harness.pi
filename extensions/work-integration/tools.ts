/**
 * The tool surface, in one import.
 *
 * One tool so far, and the barrel still earns its place: it is
 * what `index.ts` imports, so the wiring there stays a table of
 * contents rather than a list of paths, and the second tool costs
 * a line here instead of a change there.
 */

export { registerWorkTool } from "./tools/tree.js";
