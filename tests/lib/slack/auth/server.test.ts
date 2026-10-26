/**
 * The local server Slack's web redirect lands on.
 */

import { describe } from "vitest";
import { waitForOAuthCallback } from "../../../../lib/slack/auth/server.ts";
import { callbackServerCases } from "../../../core/support/oauth-callback.ts";

describe("Slack's OAuth callback server", () => {
	callbackServerCases(waitForOAuthCallback);
});
