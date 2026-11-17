#!/usr/bin/env bash
# The ssh guard's one check, which each stand-in in bin/ runs as
# `guard.bash <its folder> <program> <arguments>`: refuse ssh, scp,
# sftp or rsync reaching one of the person's own machines, named in
# PI_SSH_GUARD_MACHINES, and run every other call as the real program
# found on PATH after the stand-ins (lib/internal/shell/ssh-guard.ts).
# It is written for bash 3.2 too, as a Mac's /bin/bash is.

bin=$1
program=$2
shift 2
asked=("$@")

# Each pass through the guard is counted, so a wrapper that only ever
# calls `ssh` by name ends here rather than coming back forever.
depth=$((${PI_SSH_GUARD_DEPTH:-0} + 1))
if [ "$depth" -gt 16 ]; then
	echo "ssh-guard: $program keeps coming back to the guard; nothing ran" >&2
	exit 127
fi
export PI_SSH_GUARD_DEPTH=$depth

# The real program: the first on PATH that is no guard's stand-in and
# no wrapper this call already passed through, so a wrapper that calls
# `ssh` by name, or a second guard folder, reaches the next one. Only a
# script is marked as passed: the real ssh is a program, so the `ssh` a
# ProxyCommand runs under it reaches that same ssh again.
passed=":${PI_SSH_GUARD_THROUGH:-}:"
script() {
	local head=""
	IFS= read -r -n 2 head <"$1" 2>/dev/null
	[ "$head" = "#!" ]
}
found() {
	local dir
	local IFS=:
	for dir in $PATH; do
		[ -n "$dir" ] || continue
		[ "$dir" = "$bin" ] && continue
		[ -f "$dir/../guard.bash" ] && [ -d "$dir/../bin" ] && continue
		[ -x "$dir/$1" ] && [ ! -d "$dir/$1" ] || continue
		case "$passed" in *":$dir/$1:"*) continue ;; esac
		printf '%s\n' "$dir/$1"
		return 0
	done
	return 1
}
real=$(found "$program") || {
	echo "ssh-guard: no $program on PATH after the guard's own" >&2
	exit 127
}
pass() {
	if script "$real"; then
		PI_SSH_GUARD_THROUGH="${PI_SSH_GUARD_THROUGH:+$PI_SSH_GUARD_THROUGH:}$real"
		export PI_SSH_GUARD_THROUGH
	fi
	exec "$real" "${asked[@]}"
}

# The guard's own `ssh -G` lookup, through a wrapper, only reads settings.
[ -n "${PI_SSH_GUARD_LOOKUP:-}" ] && [ "${asked[0]:-}" = -G ] && pass

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
machines=$(lower "${PI_SSH_GUARD_MACHINES:-}")
[ -n "$machines" ] || pass
ssh_real=$(found ssh) || ssh_real=""

# What ssh's settings make of a host, given the options the call passed
# (-F, -o HostName=, -p, -P, -J): the name it connects to, lower-cased,
# and its port.
lookup() {
	[ -n "$ssh_real" ] || return 1
	PI_SSH_GUARD_LOOKUP=1 "$ssh_real" -G "$@" 2>/dev/null </dev/null | {
		name="" port=""
		while read -r key value; do
			case "$key" in
			hostname) name=$(lower "$value") ;;
			port) port=$value ;;
			esac
		done
		[ -n "$name" ] && printf '%s %s' "$name" "$port"
	}
}
connects_to() {
	local name port
	read -r name port <<<"$(lookup "$@")"
	printf '%s' "$name"
}

# This machine's loopback, in each spelling that reaches it.
loopback() {
	case "$1" in localhost | 127.* | ::1 | 0 | 0.0.0.0) return 0 ;; esac
	return 1
}

# Every name a realm machine goes by: its own, on the local network, and
# what the person's ssh settings connect to for it, which may be an
# address. A machine those settings reach through a tunnel on the
# loopback keeps only its names, so it can't claim every loopback port.
here=$(lower "${PI_SSH_GUARD_HERE:-}")
names_of() {
	local machine=$1 through
	printf '%s\n%s.local\n%s.lan\n' "$machine" "$machine" "$machine"
	through=$(connects_to "$machine")
	loopback "$through" || printf '%s\n' "$through"
}

# The realm machine a host is, judged by the name ssh connects to. The
# loopback is this machine only on ssh's own port: on another it is a
# local VM or container, which is not the person's.
machine_of() {
	local host want name port known names
	host=$(lower "${1##*@}")
	host=${host#[}
	host=${host%%]*}
	shift
	read -r name port <<<"$(lookup "$@" "$host")"
	[ -n "$name" ] || name=$host
	for want in $machines; do
		names=$(names_of "$want")
		while read -r known; do
			[ -n "$known" ] || continue
			if [ "$name" = "$known" ] || [ "$host" = "$known" ]; then
				printf '%s' "$want"
				return 0
			fi
		done <<<"$names"
	done
	if [ -n "$here" ] && { loopback "$name" || loopback "$host"; }; then
		[ "${port:-22}" = 22 ] || return 1
		printf '%s' "$here"
		return 0
	fi
	return 1
}

# The port a URI names, as `-p` for the lookup, or nothing.
uri_port() {
	local rest
	case "$1" in scp://* | sftp://* | ssh://*) ;; *) return 0 ;; esac
	rest=${1#*://}
	rest=${rest%%/*}
	rest=${rest##*@}
	case "$rest" in \[*\]:*) rest=${rest##*]:} ;; *:*) rest=${rest##*:} ;; *) return 0 ;; esac
	case "$rest" in "" | *[!0-9]*) return 0 ;; esac
	printf '%s\n%s\n' -p "$rest"
}

refuse() {
	local route="mycelium run --need machine=$1 -- <command>"
	cat >&2 <<-SAID
		ssh-guard: refused: this $program reaches $1, one of the person's own
		machines, past the fence its node lays there. Ask the node to run it:
		  $route
		A copy has no route through the node yet: say what you need to your
		orchestrator. (The harness's ssh guard, its package config's
		"ssh-guard" setting.)
	SAID
	exit 126
}

# The host a copy's argument names, as scp, sftp and rsync write one.
remote_of() {
	local rest host
	case "$1" in
	scp://* | sftp://* | ssh://*)
		rest=${1#*://}
		rest=${rest%%/*}
		host=${rest%:*}
		case "$rest" in \[* | *@\[*) host=${rest%%]*}] ;; esac
		printf '%s' "$host"
		return 0
		;;
	/* | ./* | ../* | -* | rsync://*) return 1 ;;
	\[*\]:* | *@\[*\]:*)
		host=${1%%]*}
		printf '%s' "${host#*[}"
		return 0
		;;
	*::*) return 1 ;;
	*:*)
		host=${1%%:*}
		case "$host" in */* | "") return 1 ;; esac
		printf '%s' "$host"
		return 0
		;;
	esac
	return 1
}

# The options ssh, scp and sftp hand ssh's settings: -F, -o, -J, -p/-P.
settings=()
# The operands after options, and the option letters seen.
operands=()
flags=""
options() {
	local valued=$1 word rest letter value
	shift
	while [ $# -gt 0 ]; do
		word=$1
		shift
		case "$word" in
		--)
			operands+=("$@")
			return
			;;
		-?*)
			rest=${word#-}
			while [ -n "$rest" ]; do
				letter=${rest:0:1}
				rest=${rest:1}
				flags="$flags$letter"
				case "$valued" in *"$letter"*)
					if [ -n "$rest" ]; then
						value=$rest
					elif [ $# -gt 0 ]; then
						value=$1
						shift
					else
						value=""
					fi
					case "$letter" in
					F | o | J | p) settings+=("-$letter" "$value") ;;
					# ssh's -P names a tag; scp's and sftp's is the port.
					P) [ "$program" = ssh ] && settings+=(-P "$value") || settings+=(-p "$value") ;;
					esac
					rest=""
					;;
				esac
			done
			;;
		*)
			operands+=("$word")
			# ssh reads options after its host too, then the command.
			if [ "$program" = ssh ] && [ ${#operands[@]} -eq 1 ]; then
				continue
			fi
			if [ "$program" = ssh ] || [ "$program" = sftp ]; then
				operands+=("$@")
				return
			fi
			;;
		esac
	done
}

case "$program" in
ssh)
	options "BbcDEeFIiJLlmOoPpQRSWw" "${asked[@]}"
	[ ${#operands[@]} -gt 0 ] || pass
	# ssh's destination is a host, or a URI; never an scp `host:path`,
	# which would cut an IPv6 address at its first colon.
	case "${operands[0]}" in
	ssh://*) host=$(remote_of "${operands[0]}") ;;
	*) host=${operands[0]} ;;
	esac
	extra=($(uri_port "${operands[0]}"))
	machine=$(machine_of "$host" "${settings[@]}" "${extra[@]}") || pass
	# Asking ssh about its settings, or only forwarding, runs nothing there.
	case "$flags" in *G*) pass ;; esac
	if [ ${#operands[@]} -eq 1 ]; then
		case "$flags" in *N* | *O* | *W*) pass ;; esac
	fi
	refuse "$machine"
	;;
sftp)
	options "BbcDFiJloPRSsX" "${asked[@]}"
	[ ${#operands[@]} -gt 0 ] || pass
	host=$(remote_of "${operands[0]}") || host=${operands[0]}
	extra=($(uri_port "${operands[0]}"))
	machine=$(machine_of "$host" "${settings[@]}" "${extra[@]}") || pass
	refuse "$machine"
	;;
scp)
	options "cDFiJloPSX" "${asked[@]}"
	for word in "${operands[@]}"; do
		host=$(remote_of "$word") || continue
		extra=($(uri_port "$word"))
		machine=$(machine_of "$host" "${settings[@]}" "${extra[@]}") && refuse "$machine"
	done
	pass
	;;
rsync)
	# The ssh rsync runs (-e, --rsh) hands its own options to the lookup.
	rsh=""
	next=""
	for word in "${asked[@]}"; do
		if [ -n "$next" ]; then
			rsh=$word
			next=""
			continue
		fi
		case "$word" in
		-e | --rsh) next=1 ;;
		--rsh=*) rsh=${word#--rsh=} ;;
		-e?*) rsh=${word#-e} ;;
		esac
	done
	if [ -n "$rsh" ]; then
		read -r -a words <<<"$rsh"
		program=ssh options "BbcDEeFIiJLlmOoPpQRSWw" "${words[@]:1}"
	fi
	for word in "${asked[@]}"; do
		host=$(remote_of "$word") || continue
		extra=($(uri_port "$word"))
		machine=$(machine_of "$host" "${settings[@]}" "${extra[@]}") && refuse "$machine"
	done
	pass
	;;
esac
pass
