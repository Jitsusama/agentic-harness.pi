#!/bin/sh
# E9's stand-in mycelium: it answers the cutover's `sessions` from the file
# the test wrote, and hands every other call to the next mycelium on PATH,
# the seal's own. It skips itself by file rather than by folder name, since
# the sealed PATH may have no dirname to name its folder with.
if [ "$3" = sessions ]; then exec cat "$MACHINE_DIR/sessions.json"; fi
IFS=:
for dir in $PATH; do
	[ -x "$dir/mycelium" ] && ! [ "$dir/mycelium" -ef "$0" ] && exec "$dir/mycelium" "$@"
done
echo "no mycelium past the E9 stand-in: $*" >&2
exit 127
