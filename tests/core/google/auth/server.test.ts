/**
 * The local server Google's web redirect lands on.
 */

import { describe } from "vitest";
import { waitForOAuthCallback } from "../../../../lib/core/google/auth/server.ts";
import { callbackServerCases } from "../../support/oauth-callback.ts";

describe("Google's OAuth callback server", () => {
	callbackServerCases(waitForOAuthCallback);
});
