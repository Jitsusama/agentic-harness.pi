/**
 * Slack library: API client, authentication, renderers,
 * resolvers and shared types.
 *
 * Public entry point for external consumers. Everything but the
 * interactive auth orchestration lives in agentic-harness.core now;
 * `ensureAuthenticated` (this package's own `./auth`) is the piece
 * that needs pi's UI to run the setup wizard and/or OAuth flow.
 */

export * from "@jitsusama/agentic-harness.core/slack";
export { ensureAuthenticated } from "./auth/index.js";
