#!/usr/bin/env bash
# A stand-in for ssh, scp, sftp or rsync in the ssh guard's tests, by the
# name it is linked as. It says on stderr that it ran, each argument in
# brackets, and answers `ssh -G` as a person's settings might: `eq` is an
# alias for equilibrius.lan, and equilibrius and `eqip` connect to its
# address.
name=${0##*/}
if [ "$name" = ssh ] && [ "$1" = -G ]; then
	shift
	named=""
	while [ $# -gt 1 ]; do
		case "$1" in
		-o)
			case "$2" in HostName=*) named=${2#HostName=} ;; esac
			shift 2
			;;
		-?) shift 2 ;;
		*) shift ;;
		esac
	done
	host=${named:-$1}
	case "$host" in
	eq) host=equilibrius.lan ;;
	eqip | equilibrius) host=192.168.4.49 ;;
	esac
	echo "hostname $host"
	exit 0
fi
printf 'REAL %s ' "$name" >&2
for word in "$@"; do printf '[%s]' "$word" >&2; done
echo >&2
