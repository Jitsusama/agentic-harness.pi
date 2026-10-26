/**
 * The local server Google's web redirect lands on.
 */

import { describe } from "vitest";
import { waitForOAuthCallback } from "../../../../lib/google/auth/server.ts";
import { callbackServerCases } from "../../../core/support/oauth-callback.ts";

describe("Google's OAuth callback server", () => {
	callbackServerCases(waitForOAuthCallback);
});
