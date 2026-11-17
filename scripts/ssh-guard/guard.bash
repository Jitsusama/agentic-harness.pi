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

# The real program: the first on PATH that isn't a stand-in.
bin_real=$(cd "$bin" 2>/dev/null && pwd -P)
found() {
	local dir
	local IFS=:
	for dir in $PATH; do
		[ -n "$dir" ] || continue
		[ "$dir" = "$bin" ] && continue
		[ "$dir" = "$bin_real" ] && continue
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
pass() { exec "$real" "${asked[@]}"; }

machines=$(printf '%s' "${PI_SSH_GUARD_MACHINES:-}" | tr '[:upper:]' '[:lower:]')
[ -n "$machines" ] || pass

# A host's first label, lower-cased, without its login, brackets or port.
label() {
	local host=${1##*@}
	host=${host#[}
	host=${host%%]*}
	host=${host%%:*}
	printf '%s' "${host%%.*}" | tr '[:upper:]' '[:lower:]'
}

# The realm machine `host` names, by its own name or by the hostname
# ssh's settings give it, or nothing.
machine_of() {
	local name want ssh_real
	name=$(label "$1")
	for want in $machines; do
		[ "$name" = "$want" ] && { printf '%s' "$want"; return 0; }
	done
	ssh_real=$(found ssh) || return 1
	name=$("$ssh_real" -G "$1" 2>/dev/null | while read -r key value; do
		[ "$key" = hostname ] && { printf '%s' "$value"; break; }
	done)
	[ -n "$name" ] || return 1
	name=$(label "$name")
	for want in $machines; do
		[ "$name" = "$want" ] && { printf '%s' "$want"; return 0; }
	done
	return 1
}

refuse() {
	cat >&2 <<-SAID
		ssh-guard: refused: this $program reaches $1, one of the person's own
		machines, past the fence its node lays there. Ask the node to run it:
		  mycelium run --need machine=$1 -- <command>
		(The harness's ssh guard, its package config's "ssh-guard" setting.)
	SAID
	exit 126
}

# The host a copy's argument names, as scp and rsync write one, or nothing.
remote_of() {
	case "$1" in
	scp://* | sftp://*)
		local rest=${1#*://}
		printf '%s' "${rest%%/*}"
		return 0
		;;
	/* | ./* | ../* | -*) return 1 ;;
	*::*) return 1 ;;
	*:*)
		local host=${1%%:*}
		case "$host" in */*) return 1 ;; esac
		[ -n "$host" ] && printf '%s' "$host"
		return 0
		;;
	esac
	return 1
}

# Walk options as getopt would, given those that take a value; leaves
# the rest in `operands` and the flags seen in `flags`.
operands=()
flags=""
options() {
	local valued=$1 word rest letter
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
					[ -z "$rest" ] && [ $# -gt 0 ] && shift
					rest=""
					;;
				esac
			done
			;;
		*)
			operands+=("$word")
			[ "$program" = ssh ] || [ "$program" = sftp ] && {
				operands+=("$@")
				return
			}
			;;
		esac
	done
}

case "$program" in
ssh)
	options "BbcDEeFIiJLlmOoPpQRSWw" "${asked[@]}"
	[ ${#operands[@]} -gt 0 ] || pass
	machine=$(machine_of "${operands[0]}") || pass
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
	machine=$(machine_of "$host") || pass
	refuse "$machine"
	;;
scp | rsync)
	for word in "${asked[@]}"; do
		host=$(remote_of "$word") || continue
		machine=$(machine_of "$host") && refuse "$machine"
	done
	pass
	;;
esac
pass
