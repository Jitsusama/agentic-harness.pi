#!/usr/bin/env bash
# A stand-in for ssh, scp, sftp or rsync in the ssh guard's tests, by the
# name it is linked as. It says on stderr that it ran, each argument in
# brackets, and answers `ssh -G` as a person's settings might: `eq` is an
# alias for equilibrius.lan, equilibrius and `eqip` connect to its
# address, a `-P` tag must be one it knows, a `-F` file's `HostName` line
# wins, and `-p` sets the port.
name=${0##*/}
if [ "$name" = ssh ] && [ "$1" = -G ]; then
	shift
	named=""
	port=22
	while [ $# -gt 1 ]; do
		case "$1" in
		-o)
			case "$2" in HostName=*) named=${2#HostName=} ;; esac
			shift 2
			;;
		-F)
			from=$(sed -n 's/^[[:space:]]*HostName[[:space:]]*//p' "$2")
			[ -n "$from" ] && named=$from
			shift 2
			;;
		-p)
			case "$2" in "" | *[!0-9]*)
				echo "Bad port '$2'" >&2
				exit 255
				;;
			esac
			port=$2
			shift 2
			;;
		-P)
			[ "$2" = work ] || {
				echo "no such tag: $2" >&2
				exit 255
			}
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
	echo "port $port"
	exit 0
fi
printf 'REAL %s ' "$name" >&2
for word in "$@"; do printf '[%s]' "$word" >&2; done
echo >&2
