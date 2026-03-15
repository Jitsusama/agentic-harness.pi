/**
 * Validation helpers and error messages for OAuth credential setup.
 */

/** Error messages for invalid credentials. */
export const ERRORS = {
	invalidClientId:
		"Invalid Client ID. It should end with .apps.googleusercontent.com",
	missingClientSecret: "Client Secret is required.",
};

/** Validate OAuth Client ID format. */
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
