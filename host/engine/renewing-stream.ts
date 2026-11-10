/**
 * Whether a provider stream is to be opened a second time because the
 * gateway refused the key it was opened with. A host outlives the key it
 * started with: the gateway key renews about daily, and a request sent on
 * the old one fails with nothing streamed. pi's own retry leaves an
 * authentication failure alone, so the person would see the refusal although
 * a fresh key was a moment away. Providers say a refusal as their first
 * event, before any of the answer, so opening once more shows nothing twice.
 * The hosted agent reads the stream itself, as pi's loop does, and asks this
 * of its first event; wrapping the stream instead would hand every event on
 * later than pi's loop sees it.
 */
import type { AssistantMessage, ProviderEvent } from "./pi-types.ts";

/** What says whether the key a refusal came from has since been renewed. */
export type Renewed = (error: AssistantMessage) => Promise<boolean>;

/**
 * Whether a stream's first event is an error `renewed` says came from a key
 * it has since renewed, so the request goes once more on the new key.
 */
export async function refusedOldKey(
	first: ProviderEvent,
	renewed: Renewed,
): Promise<boolean> {
	return first.type === "error" && first.error !== undefined
		? await renewed(first.error)
		: false;
}
