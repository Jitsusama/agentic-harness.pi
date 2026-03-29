/**
 * Google Workspace authentication: OAuth flow, token
 * management, credential storage and device flow.
 */

export { openInBrowser } from "./browser.js";
export {
	clearAllConfig,
	getCredentials,
	getDefaultAccount,
	listAccounts,
	type OAuthAppCredentials,
	saveAccount,
	setDefaultAccount,
	storeCredentials,
} from "./credentials.js";
export {
	authenticateWithFallback,
	type OAuthFlowResult,
} from "./dual-flow.js";
export {
	getOAuthApp,
	hasOAuthApp,
	storeOAuthApp,
} from "./oauth-app.js";
export {
	createOAuth2Client,
	type DeviceFlowResponse,
	extractTokens,
	initiateDeviceFlow,
	type OAuth2Config,
	pollForDeviceAuthorization,
	refreshTokenIfNeeded,
	SCOPES,
	setCredentials,
} from "./oauth.js";
export {
	type OAuthCallbackResult,
	waitForOAuthCallback,
} from "./server.js";
