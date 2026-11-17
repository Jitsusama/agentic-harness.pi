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

# The real program: the first on PATH that is no guard's stand-in and
# no program this call already passed through, so a wrapper that calls
# `ssh` by name, or a second guard folder, reaches the next one rather
# than coming back here forever.
passed=":${PI_SSH_GUARD_THROUGH:-}:"
found() {
	local dir
	local IFS=:
	for dir in $PATH; do
		[ -n "$dir" ] || continue
		[ "$dir" = "$bin" ] && continue
		[ -f "$dir/../guard.bash" ] && [ -d "$dir/../bin" ] && continue
		case "$passed" in *":$dir/$1:"*) continue ;; esac
		if [ -x "$dir/$1" ] && [ ! -d "$dir/$1" ]; then
			printf '%s\n' "$dir/$1"
			return 0
		fi
	done
	return 1
}
real=$(found "$program") || {
	echo "ssh-guard: no $program on PATH after the guard's own" >&2
	exit 127
}
pass() {
	PI_SSH_GUARD_THROUGH="${PI_SSH_GUARD_THROUGH:+$PI_SSH_GUARD_THROUGH:}$real"
	export PI_SSH_GUARD_THROUGH
	exec "$real" "${asked[@]}"
}

# The guard's own `ssh -G` lookup, through a wrapper, only reads settings.
[ -n "${PI_SSH_GUARD_LOOKUP:-}" ] && pass

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
machines=$(lower "${PI_SSH_GUARD_MACHINES:-}")
[ -n "$machines" ] || pass
ssh_real=$(found ssh) || ssh_real=""

# What ssh's settings make of a host, given the options the call passed
# (-F, -o HostName=, -p, -J): the name it connects to, lower-cased.
connects_to() {
	[ -n "$ssh_real" ] || return 1
	PI_SSH_GUARD_LOOKUP=1 "$ssh_real" -G "$@" 2>/dev/null </dev/null | while read -r key value; do
		[ "$key" = hostname ] && { lower "$value"; break; }
	done
}

# Every name a realm machine goes by: its own, on the local network, as
# this machine its loopback, and what the person's ssh settings connect
# to for it, which may be an address.
here=$(lower "${PI_SSH_GUARD_HERE:-}")
names_of() {
	local machine=$1
	printf '%s\n%s.local\n%s.lan\n' "$machine" "$machine" "$machine"
	[ "$machine" = "$here" ] && printf 'localhost\n127.0.0.1\n::1\n'
	connects_to "$machine"
	echo
}

# The realm machine a host is, judged by the name ssh connects to.
machine_of() {
	local host want name known names
	host=$(lower "${1##*@}")
	host=${host#[}
	host=${host%%]*}
	shift
	name=$(connects_to "$@" "$host") || name=""
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
	return 1
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
		case "$rest" in \[*) host=${rest%%]*}] ;; esac
		printf '%s' "$host"
		return 0
		;;
	/* | ./* | ../* | -* | rsync://*) return 1 ;;
	*::*) return 1 ;;
	\[*\]:*)
		host=${1%%]*}
		printf '%s' "${host#[}"
		return 0
		;;
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
					F | o | J) settings+=("-$letter" "$value") ;;
					p | P) settings+=(-p "$value") ;;
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
	host=$(remote_of "${operands[0]}") || host=${operands[0]}
	machine=$(machine_of "$host" "${settings[@]}") || pass
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
	machine=$(machine_of "$host" "${settings[@]}") || pass
	refuse "$machine"
	;;
scp)
	options "cDFiJloPSX" "${asked[@]}"
	for word in "${operands[@]}"; do
		host=$(remote_of "$word") || continue
		machine=$(machine_of "$host" "${settings[@]}") && refuse "$machine"
	done
	pass
	;;
rsync)
	for word in "${asked[@]}"; do
		host=$(remote_of "$word") || continue
		machine=$(machine_of "$host") && refuse "$machine"
	done
	pass
	;;
esac
pass
