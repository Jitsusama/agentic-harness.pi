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

export { registerAskTool } from "./tools/ask.ts";
export { registerDraftTool } from "./tools/draft.ts";
export { registerOfferTool } from "./tools/offer.ts";
export { registerReviewTool } from "./tools/read.ts";
export { registerSayTool } from "./tools/say.ts";
export { registerSeeTool } from "./tools/see.ts";
