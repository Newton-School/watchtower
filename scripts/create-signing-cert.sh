#!/usr/bin/env bash
#
# Create a free, self-signed macOS code-signing certificate so every Watchtower
# build carries a STABLE signing identity. macOS TCC ties permission grants
# (Documents/Desktop/Downloads, etc.) to that identity — an ad-hoc build's
# identity (the binary cdhash) changes every rebuild, so the grant resets on
# every install. Sign with a fixed cert and you grant once; it persists.
#
# Run this ONCE on each machine that builds the app:
#     bash scripts/create-signing-cert.sh
#
# Then build normally — scripts/run-tauri.mjs auto-detects the identity and
# passes APPLE_SIGNING_IDENTITY to Tauri. No Apple Developer account required.
#
# This is NOT notarization: a self-signed app still trips Gatekeeper if it's
# quarantined (downloaded). Installing by copying the .app locally doesn't set
# quarantine, so this is fine for local/internal use. For wider distribution,
# use a real Developer ID + notarization instead.
set -euo pipefail

NAME="${1:-Watchtower Self-Signed}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "✓ Code-signing identity \"$NAME\" already exists — nothing to do."
  exit 0
fi

gui_fallback() {
  cat <<EOF

✗ Could not create the certificate via the CLI.

Use Keychain Access instead (100% reliable, ~1 minute, one time):
  1. Open Keychain Access.
  2. Menu: Certificate Assistant → Create a Certificate…
  3. Name: $NAME
     Identity Type: Self-Signed Root
     Certificate Type: Code Signing
  4. Create, then keep the defaults.
Then rebuild: npm run tauri:build:mac
EOF
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Generating a self-signed code-signing certificate: \"$NAME\""
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1 || gui_fallback

# `-legacy` makes OpenSSL 3.x emit a PKCS#12 (RC2/3DES + SHA1 MAC) that macOS
# `security import` accepts — the default OpenSSL 3.x format fails with
# "MAC verification failed". Older OpenSSL ignores the flag harmlessly.
openssl pkcs12 -export -legacy -out "$TMP/cert.p12" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass: >/dev/null 2>&1 ||
  openssl pkcs12 -export -out "$TMP/cert.p12" \
    -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass: >/dev/null 2>&1 || gui_fallback

# Import key+cert into the login keychain and authorize codesign to use it.
security import "$TMP/cert.p12" -k "$KEYCHAIN" -P "" -T /usr/bin/codesign || gui_fallback

# Let codesign use the private key without an interactive prompt on every build.
# This needs your login (keychain) password — macOS will ask for it once.
echo "Authorizing codesign to use the key (you may be prompted for your login password)…"
security set-key-partition-list -S apple-tool:,apple: -s "$KEYCHAIN" >/dev/null 2>&1 ||
  echo "  (skipped partition-list auth — if a build prompts to 'allow codesign to access the key', click Always Allow once.)"

# Confirm codesign can actually see the identity now.
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "✓ Created code-signing identity \"$NAME\"."
  echo "  Rebuild the app (npm run tauri:build:mac). The first install will still"
  echo "  ask for any protected-folder access once; after that the grant persists."
else
  gui_fallback
fi
