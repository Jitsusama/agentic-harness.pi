/**
 * A git remote URL as it is safe to show a person.
 */

/**
 * The userinfo of a URL: everything between the scheme and the `@`
 * that introduces the host. It cannot cross a slash, so an at sign
 * later in the path is part of the path.
 */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i;

/**
 * A remote URL with its credential removed, if it carried one.
 *
 * The whole userinfo goes, not just the password. A token is accepted
 * in either position, so `token@host` is as much a secret as
 * `user:token@host`, and keeping the user would leak exactly the form
 * that looks harmless. What is lost is `git@` on an ssh URL, which
 * names no one and is worth less than the rule being simple.
 *
 * Only URLs with a scheme. An scp-style remote, `git@host:path`, has
 * no userinfo field to speak of and no way to carry a password, so it
 * is left as written rather than rewritten into something the person
 * reading it never typed.
 *
 * For display only. The remote a fetch is run against keeps whatever
 * it needs to authenticate, because taking the credential out of that
 * one would not hide it, it would break it.
 */
export function withoutCredentials(remoteUrl: string): string {
	return remoteUrl.replace(USERINFO, "$1");
}
