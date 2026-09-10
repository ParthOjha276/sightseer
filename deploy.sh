#!/bin/sh
# Builds the deployable site into dist/ and zips it.
#
# There is no build step. This exists only to keep the submission note, the
# task PDF, the tests and the local tooling out of a public bucket.
set -e
cd "$(dirname "$0")"

rm -rf dist sightseer-site.zip
mkdir -p dist
cp index.html styles.css app.js engine.js dist/
cp -R fonts dist/fonts

echo "dist/ ready:"
find dist -type f | sort | sed 's/^/  /'

# The zip is only for drag-and-drop hosts. Skip it where zip is unavailable,
# such as a CI build image, so the build does not fail over a convenience.
if command -v zip >/dev/null 2>&1; then
  ( cd dist && zip -qr ../sightseer-site.zip . -x '.*' -x '__MACOSX/*' )
  echo "sightseer-site.zip: $(du -h sightseer-site.zip | cut -f1)"
else
  echo "(zip unavailable, skipped)"
fi
