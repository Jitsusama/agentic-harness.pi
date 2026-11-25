# What a git pi queued in a folder with no git at or above it runs as
# once its turn comes (queued-exec.ts). The guard read that folder when
# the git was asked for, which may be hours before it runs, and a
# command can put a .git there in between, naming a git folder whose
# hooks and settings git would run outside the sandbox. So the folder
# and every one above it are read again now, as tree-git.ts's foundGit
# reads them, and git runs only if none holds a git yet; it then finds
# no repository above the folder (GIT_CEILING_DIRECTORIES) whatever is
# put there after this look.
#
# $1 is the folder, as it really is; the rest is the command to run.
set -u
folder=$1
shift
at=$folder
while :; do
	if [ -e "$at/.git" ] || [ -L "$at/.git" ] ||
		{ { [ -e "$at/HEAD" ] || [ -L "$at/HEAD" ]; } &&
			{ [ -e "$at/objects" ] || [ -L "$at/objects" ]; }; }; then
		printf '%s\n' "$at holds a git now that it didn't when this git was queued, so git won't run: a command may have put it there." >&2
		exit 126
	fi
	[ "$at" = / ] && break
	at=${at%/*}
	at=${at:-/}
done
parent=${folder%/*}
GIT_CEILING_DIRECTORIES=${parent:-/} exec "$@"
