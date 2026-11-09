/** A real session identity for result-store tests without a runner. */
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Create a fresh session whose result directory cannot overlap another test. */
export function resultSession() {
	return { sessionManager: SessionManager.inMemory(process.cwd()) };
}
