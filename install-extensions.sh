#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if command -v bun >/dev/null 2>&1; then
  installer=bun
elif command -v npm >/dev/null 2>&1; then
  installer=npm
else
  echo "Neither bun nor npm was found in PATH." >&2
  exit 1
fi

export installer
found=false
for base in "$ROOT/extensions" "$ROOT/git"; do
  [ -d "$base" ] || continue
  if find "$base" -type d -name node_modules -prune -o -type f -name package.json -print \
    -exec sh -c '
      for manifest do
        dir=${manifest%package.json}
        echo "Installing dependencies in $dir using $installer..."
        (cd "$dir" && "$installer" i) || exit 1
      done
    ' sh {} +; then
    :
  else
    exit 1
  fi
done

echo "All extension dependencies installed."
