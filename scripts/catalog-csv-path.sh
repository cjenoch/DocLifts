# shellcheck shell=bash
# shellcheck disable=SC2034  # CATALOG_CSV_* are read by the script that sources this.
# Where scripts/catalog-prod.sh reads its CSV from. Kept in its own file, and
# free of side effects when sourced, so the rules can be tested without docker,
# sudo or production (src/lib/server/catalog-prod.test.ts sources only this).
#
# Two kinds of path are accepted:
#
#   - Relative: a file COMMITTED in this repository, read from the repository
#     root. The builder image carries the checkout, so the importer reads it at
#     the same relative path inside the image. The public snapshots in
#     data/catalog/ are passed this way, exactly as before 0.5.1.
#   - Absolute, outside the repository: a readable file anywhere else, such as
#     the owner's private snapshot directory on the VPS. It is bind-mounted
#     read-only into the import container at CATALOG_CSV_CONTAINER_PATH, and
#     the importer is given that path. It never enters the image or the repo.
#
# An absolute path that points INSIDE the repository is treated as the
# relative path it names, so it must be committed too. Everything else is
# refused with one line on stderr saying why and what to do instead.
#
# resolve_catalog_csv <csv argument> <repository root>
#   Returns 0 and sets:
#     CATALOG_CSV_ARG    the path the importer is given
#     CATALOG_CSV_MOUNT  the host file to bind-mount, or empty for a repo file
#   Returns 1 for a file that cannot be used (missing, unreadable, empty, not
#   committed, modified), 2 for a malformed argument.

CATALOG_CSV_CONTAINER_PATH=/import/catalog.csv

resolve_catalog_csv() {
	local arg="${1:-}" root="${2:-}" abs
	CATALOG_CSV_ARG=""
	CATALOG_CSV_MOUNT=""
	if [[ -z "$arg" || -z "$root" ]]; then
		echo "usage: resolve_catalog_csv <csv path> <repository root>" >&2
		return 2
	fi
	if ! root="$(cd "$root" 2>/dev/null && pwd -P)"; then
		echo "repository root not found: $2" >&2
		return 2
	fi

	if [[ "$arg" == /* ]]; then
		if [[ ! -e "$arg" ]]; then
			echo "CSV not found: $arg" >&2
			return 1
		fi
		abs="$(readlink -f -- "$arg")"
		if [[ ! -f "$abs" ]]; then
			echo "CSV is not a regular file: $arg" >&2
			return 1
		fi
		if [[ ! -r "$abs" ]]; then
			echo "CSV is not readable by $(id -un): $arg" >&2
			return 1
		fi
		if [[ ! -s "$abs" ]]; then
			echo "CSV is empty: $arg" >&2
			return 1
		fi
		case "$abs" in
		"$root"/*)
			# Inside the repository after all: the committed-file rule applies.
			arg="${abs#"$root"/}"
			;;
		*)
			# docker -v splits its argument on ':', so such a path cannot be mounted.
			if [[ "$abs" == *:* ]]; then
				echo "CSV path contains ':', which docker cannot mount; rename or move it: $abs" >&2
				return 2
			fi
			CATALOG_CSV_MOUNT="$abs"
			CATALOG_CSV_ARG="$CATALOG_CSV_CONTAINER_PATH"
			return 0
			;;
		esac
	fi

	case "/$arg/" in
	*/../*)
		echo "a relative CSV path must stay inside the repository (no '..'): $arg" >&2
		return 2
		;;
	esac
	if [[ ! -e "$root/$arg" ]]; then
		echo "CSV not found in this checkout: $arg (a relative path is read from the repository root; pass an absolute path for a file outside the repository)" >&2
		return 1
	fi
	if [[ ! -f "$root/$arg" ]]; then
		echo "CSV is not a regular file: $arg" >&2
		return 1
	fi
	# safe.directory: under sudo, git otherwise refuses a checkout owned by
	# another user ("dubious ownership"), which would read as "not committed".
	if ! git -c safe.directory="$root" -C "$root" ls-files --error-unmatch -- "$arg" >/dev/null 2>&1; then
		echo "CSV is inside the repository but not committed: $arg (commit it, or keep it outside the repository and pass its absolute path)" >&2
		return 1
	fi
	if ! git -c safe.directory="$root" -C "$root" diff --quiet HEAD -- "$arg" 2>/dev/null; then
		echo "CSV has uncommitted changes: $arg (the image would carry the edited file; commit it or restore it)" >&2
		return 1
	fi
	CATALOG_CSV_ARG="$arg"
	return 0
}
