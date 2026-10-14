#!/usr/bin/env bash
# Creates Silo's stable macOS code-signing identity (run once per release machine).
#
# Ad hoc signatures change with every build, so macOS treats each update as a new
# app and drops its privacy grants (Full Disk Access, removable volumes, ...).
# Signing every build with this one self-signed certificate keeps the app's
# designated requirement identical across updates, so grants survive.
#
# Output (default ~/.silo-signing, override with SILO_MAC_SIGNING_DIR):
#   silo-signing.keychain-db  dedicated keychain holding the identity
#   keychain-password         unlocks that keychain non-interactively at build time
#   silo-code-signing.p12     backup of the identity (+ p12-password)
#
# Back up the .p12 and its password. Losing them means users must grant
# permissions once more after the next update. To sign CI builds with the same
# identity, store the base64 .p12 as SILO_MAC_SIGNING_P12_BASE64 and its password
# as SILO_MAC_SIGNING_P12_PASSWORD in the repository secrets.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "Run this on macOS." >&2; exit 2; }

DIR="${SILO_MAC_SIGNING_DIR:-$HOME/.silo-signing}"
KEYCHAIN="$DIR/silo-signing.keychain-db"
NAME="Silo Code Signing"

if [ -f "$KEYCHAIN" ] && [ -f "$DIR/keychain-password" ]; then
  security unlock-keychain -p "$(cat "$DIR/keychain-password")" "$KEYCHAIN"
  echo "Silo signing identity already exists:"
  security find-identity -p codesigning "$KEYCHAIN" | grep "\"$NAME\""
  exit 0
fi

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

openssl rand -hex 24 > "$DIR/keychain-password"
openssl rand -hex 24 > "$DIR/p12-password"

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
O=Silo
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 7300 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
# macOS `security` only reads PKCS#12 files with the legacy encryption.
openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$DIR/silo-code-signing.p12" -passout "pass:$(cat "$DIR/p12-password")" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
       -out "$DIR/silo-code-signing.p12" -passout "pass:$(cat "$DIR/p12-password")"

KEYCHAIN_PASSWORD="$(cat "$DIR/keychain-password")"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$DIR/silo-code-signing.p12" -k "$KEYCHAIN" \
  -P "$(cat "$DIR/p12-password")" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

echo "Created Silo signing identity in $KEYCHAIN:"
security find-identity -p codesigning "$KEYCHAIN" | grep "\"$NAME\""
echo
echo "Back up $DIR/silo-code-signing.p12 and $DIR/p12-password somewhere safe."
