/**
 * The local server Slack's web redirect lands on.
 */

import { describe } from "vitest";
import { waitForOAuthCallback } from "../../../../lib/core/slack/auth/server.ts";
import { callbackServerCases } from "../../support/oauth-callback.ts";

describe("Slack's OAuth callback server", () => {
	callbackServerCases(waitForOAuthCallback);
});
