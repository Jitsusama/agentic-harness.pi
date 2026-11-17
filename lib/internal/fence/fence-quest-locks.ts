/**
 * The quest lock folder, bound back writable into the fence's empty
 * runtime folder, so a fenced writer and one outside take one lock.
 */

/**
 * bubblewrap's arguments for the quest lock folder in `runtimeDir`,
 * which the fence has just emptied.
 */
export function questLockArgs(_runtimeDir: string): string[] {
	return [];
}
