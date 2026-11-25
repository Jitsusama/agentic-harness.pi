# What a git pi queued in a folder with no git at or above it runs as
# once its turn comes (queued-exec.ts). The guard read that folder when
# the git was asked for, which may be hours before it runs, and a
# command can put a .git there in between, naming a git folder whose
# hooks and settings git would run outside the sandbox, or repoint a
# link in the path git was given.
#
# So git runs in the folder the guard read, as it really is, never
# through the path it was given: this shell moves into it first and
# refuses where that folder no longer stands at that path. The folder
# and every one above it are then read again, as tree-git.ts's foundGit
# reads them, and git runs only if none holds a git yet; it then finds
# no repository above the folder (GIT_CEILING_DIRECTORIES) whatever is
# put there after this look. Only a folder above renamed in the instant
# between this look and git's own is left open.
#
# $1 is the folder, as it really is; the rest is the command to run in
# it, given no -C.
set -u
folder=$1
shift
again="Nothing ran. Look at what stands there, take it out if nothing of yours put it there, and ask again."
if ! cd -P -- "$folder" 2>/dev/null || [ "$(pwd -P)" != "$folder" ]; then
	printf '%s\n' "$folder isn't where it was when this git was queued, so git won't run: a command may have moved it or a link in its path. $again" >&2
	exit 126
fi
parent=${folder%/*}
parent=${parent:-/}
case $parent in
*:*)
	# git reads its ceiling as a list split at colons.
	printf '%s\n' "$parent holds a colon, which git would read as two folders, so git won't run below it. Run it from a folder without one." >&2
	exit 126
	;;
esac
at=$folder
while :; do
	if [ -e "$at/.git" ] || [ -L "$at/.git" ] ||
		{ { [ -e "$at/HEAD" ] || [ -L "$at/HEAD" ]; } &&
			{ [ -d "$at/objects" ] || [ -L "$at/objects" ] ||
				[ -e "$at/commondir" ] || [ -L "$at/commondir" ]; }; }; then
		printf '%s\n' "$at holds a git now that it didn't when this git was queued, so git won't run: a command may have put it there. $again" >&2
		exit 126
	fi
	[ "$at" = / ] && break
	at=${at%/*}
	at=${at:-/}
done
GIT_CEILING_DIRECTORIES=$parent exec "$@"
