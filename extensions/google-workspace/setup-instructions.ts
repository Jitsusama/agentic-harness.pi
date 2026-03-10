/**
 * Setup instructions and validation for OAuth credentials.
 */

/** Setup instructions for creating OAuth credentials. */
export const SETUP_INSTRUCTIONS = {
	welcome:
		"\n⚙️  Google Workspace Setup Required\n\n" +
		"To use Google Workspace features, you need OAuth credentials.\n" +
		"This is a one-time setup that takes about 5 minutes.\n",

	steps:
		"\n📋 OAuth App Setup Instructions\n\n" +
		"Follow these steps to create OAuth credentials:\n\n" +
		"1️⃣  Create Google Cloud Project\n" +
		"   Visit: https://console.cloud.google.com/projectcreate\n" +
		"   Name: 'Pi Google Workspace' (or any name)\n" +
		"   Click 'Create' (no billing required)\n\n" +
		"2️⃣  Enable APIs\n" +
		"   Visit: https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,slides.googleapis.com\n" +
		"   Click 'Enable'\n\n" +
		"3️⃣  Create OAuth Credentials\n" +
		"   Visit: https://console.cloud.google.com/apis/credentials\n" +
		"   Click 'Create Credentials' → 'OAuth client ID'\n" +
		"   Application type: 'Desktop app' or 'TVs and Limited Input devices' (either works)\n" +
		"   Name: 'Pi Google Workspace'\n" +
		"   Click 'Create'\n" +
		"   Copy the Client ID and Client Secret\n\n" +
		"This is completely FREE and takes about 5 minutes.\n",

	success:
		"\n✓ OAuth credentials saved!\n\n" +
		"These credentials are now stored in your Pi session.\n" +
		"You won't need to enter them again.\n\n" +
		"Next step: Run /google-auth to authenticate with your Google account.",

	cancelled: "Setup cancelled. Run /google-setup when ready to configure.",

	envVarHelp:
		"OAuth credentials not configured. " +
		"Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables, " +
		"or run in interactive mode to set up.",
};

/** Prompts for user input. */
export const PROMPTS = {
	showInstructions: "Would you like to see setup instructions?",
	clientId:
		"Enter your OAuth Client ID (ends with .apps.googleusercontent.com):",
	clientSecret: "Enter your OAuth Client Secret (starts with GOCSPX-):",
};

/** Error messages. */
export const ERRORS = {
	invalidClientId:
		"Invalid Client ID. It should end with .apps.googleusercontent.com",
	missingClientSecret: "Client Secret is required.",
};

/**
 * Validate OAuth Client ID format.
 */
export function isValidClientId(clientId: string | null): boolean {
	if (!clientId) return false;
	return clientId.trim().endsWith(".apps.googleusercontent.com");
}

/**
 * Validate OAuth Client Secret format.
 * Accepts any non-empty string (format varies by OAuth client type).
 */
export function isValidClientSecret(clientSecret: string | null): boolean {
	if (!clientSecret) return false;
	return clientSecret.trim().length > 0;
}
