# Locating the Postgres binaries, portably.
#
# Sourced by both dev-db.sh (which needs initdb/pg_ctl) and start.sh (which
# needs psql). They used to look in different places, which is how one of them
# could find Postgres while the other reported it missing.
#
# `psql` and `initdb` on PATH is the exception. Homebrew's postgresql@NN is
# keg-only, so a correctly-installed Mac has neither anywhere PATH can see.
# Postgres.app keeps them under a versioned directory inside the bundle, and
# Debian under /usr/lib/postgresql/<version>/bin.

# Sorts newest-version-first. BSD `sort` has no -V, so the GNU path is tried
# and the plain reverse sort used otherwise — which still puts 16 above 14, and
# only misorders across a digit boundary that no Postgres release has reached.
_pg_newest() {
  if printf '1\n2\n' | sort -V >/dev/null 2>&1; then
    ls -d $1 2>/dev/null | sort -Vr
  else
    ls -d $1 2>/dev/null | sort -r
  fi
}

# find_pg_bin <binary> — echoes the directory containing it, or nothing.
find_pg_bin() {
  local want="${1:-initdb}" dir

  if command -v "$want" >/dev/null 2>&1; then
    dirname "$(command -v "$want")"
    return 0
  fi

  local candidates=()
  case "$(uname -s)" in
    Darwin)
      local brew_prefix
      brew_prefix="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"
      # shellcheck disable=SC2207
      candidates+=(
        $(_pg_newest "$brew_prefix/opt/postgresql@*/bin")
        $(_pg_newest "/opt/homebrew/opt/postgresql@*/bin")
        $(_pg_newest "/usr/local/opt/postgresql@*/bin")
        $(_pg_newest "/Applications/Postgres.app/Contents/Versions/*/bin")
        "$brew_prefix/bin"
      )
      ;;
    *)
      # shellcheck disable=SC2207
      candidates+=(
        $(_pg_newest "/usr/lib/postgresql/*/bin")
        /usr/bin /usr/local/bin
      )
      ;;
  esac

  for dir in "${candidates[@]}"; do
    [ -x "$dir/$want" ] && { printf '%s' "$dir"; return 0; }
  done
  return 1
}

# How to tell someone to install it, in the terms of the machine they are on.
pg_install_hint() {
  case "$(uname -s)" in
    Darwin)
      printf '  brew install postgresql@16\n\n'
      printf 'That formula is keg-only, so psql and initdb will not land on your\n'
      printf 'PATH. Scout looks inside Homebrew'"'"'s opt directory for exactly that\n'
      printf 'reason, so nothing further is needed after the install.\n'
      ;;
    *)
      printf '  sudo apt-get install postgresql        # Debian/Ubuntu\n'
      printf '  sudo dnf install postgresql-server     # Fedora/RHEL\n'
      ;;
  esac
}
