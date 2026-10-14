#!/usr/bin/env bash
# Builds the phone connection tools Silo ships inside every installer:
#   iOS:     libimobiledevice 1.4.0 tools (idevice_id, ideviceinfo, idevicepair,
#            afcclient, idevicebackup2) built from source so every platform gets
#            the same version, including afcclient.
#   Android: Google's adb from the official platform-tools download.
#
# Usage:
#   macOS:          scripts/build-phone-tools.sh x64|arm64
#   Windows (MSYS2 UCRT64 shell): scripts/build-phone-tools.sh x64
#
# Output: vendor/phone-tools/<platform>-<arch>/ (bundled as resources/phone-tools).
# macOS binaries link the libimobiledevice stack and OpenSSL statically so they
# only depend on system libraries and run on macOS 11+ for either CPU.
set -euo pipefail

ARCH="${1:-}"
case "$ARCH" in x64|arm64) ;; *) echo "usage: $0 x64|arm64" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  MINGW*|MSYS*) PLATFORM=win32 ;;
  *) echo "Unsupported build host: $(uname -s)" >&2; exit 2 ;;
esac
if [ "$PLATFORM" = win32 ] && [ "$ARCH" != x64 ]; then
  echo "Windows phone tools are built for x64 only." >&2; exit 2
fi

OPENSSL_VERSION=3.5.9
LIBPLIST_VERSION=2.8.0
GLUE_VERSION=1.3.3
USBMUXD_VERSION=2.1.1
TATSU_VERSION=1.0.5
LIMD_VERSION=1.4.0
IOS_TOOLS="idevice_id ideviceinfo idevicepair afcclient idevicebackup2"

WORK="$ROOT/vendor/.phone-tools-build/$PLATFORM-$ARCH"
SOURCES="$ROOT/vendor/.phone-tools-build/sources"
PREFIX="$WORK/prefix"
OUT="$ROOT/vendor/phone-tools/$PLATFORM-$ARCH"
STAMP="$OUT/.silo-phone-tools"
WANT_STAMP="openssl=$OPENSSL_VERSION plist=$LIBPLIST_VERSION glue=$GLUE_VERSION usbmuxd=$USBMUXD_VERSION tatsu=$TATSU_VERSION limd=$LIMD_VERSION"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT_STAMP" ]; then
  echo "Phone tools for $PLATFORM-$ARCH are already built: $OUT"
  exit 0
fi

command -v pkg-config >/dev/null || { echo "pkg-config is required (brew install pkgconf)." >&2; exit 1; }
mkdir -p "$SOURCES" "$WORK"
rm -rf "$PREFIX" "$OUT"
mkdir -p "$PREFIX/lib/pkgconfig" "$OUT/licenses"

fetch() {
  local url="$1" file="$SOURCES/$(basename "$1")"
  if [ ! -s "$file" ]; then
    curl -fsSL --retry 3 -o "$file.part" "$url" >&2
    mv "$file.part" "$file"
  fi
  echo "$file"
}

unpack() {
  local archive="$1" dir="$WORK/src"
  mkdir -p "$dir"
  tar -xf "$archive" -C "$dir"
}

JOBS="$( (sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4) )"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
unset PKG_CONFIG_PATH

if [ "$PLATFORM" = darwin ]; then
  if [ "$ARCH" = x64 ]; then CLANG_ARCH=x86_64; HOST=x86_64-apple-darwin; SSL_TARGET=darwin64-x86_64-cc
  else CLANG_ARCH=arm64; HOST=aarch64-apple-darwin; SSL_TARGET=darwin64-arm64-cc; fi
  SDK="$(xcrun --show-sdk-path)"
  export MACOSX_DEPLOYMENT_TARGET=11.0
  export CC="clang -arch $CLANG_ARCH"
  export CFLAGS="-O2 -mmacosx-version-min=11.0 -isysroot $SDK"
  export CPPFLAGS="-I$PREFIX/include"
  export LDFLAGS="-L$PREFIX/lib -mmacosx-version-min=11.0 -isysroot $SDK"
  LINK_MODE="--disable-shared --enable-static"
  # libtatsu needs libcurl; macOS ships it, but without a pkg-config file.
  cat > "$PREFIX/lib/pkgconfig/libcurl.pc" <<PC
Name: libcurl
Description: macOS system libcurl
Version: 8.0.0
Libs: -lcurl
Cflags:
PC
else
  HOST=x86_64-w64-mingw32
  SSL_TARGET=mingw64
  export CPPFLAGS="-I$PREFIX/include"
  export LDFLAGS="-L$PREFIX/lib"
  LINK_MODE="--enable-shared --disable-static"
  # Reuse MSYS2's libcurl build; everything else is built from source below.
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:/ucrt64/lib/pkgconfig"
  export PATH="$PREFIX/bin:$PATH"
fi

echo "==> OpenSSL $OPENSSL_VERSION ($PLATFORM-$ARCH)"
unpack "$(fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz")"
(
  cd "$WORK/src/openssl-$OPENSSL_VERSION"
  if [ "$PLATFORM" = darwin ]; then
    CC=clang ./Configure "$SSL_TARGET" no-shared no-tests no-docs no-apps \
      --prefix="$PREFIX" --libdir=lib -mmacosx-version-min=11.0 >/dev/null 2>&1
  else
    ./Configure "$SSL_TARGET" shared no-tests no-docs no-apps --prefix="$PREFIX" --libdir=lib >/dev/null 2>&1
  fi
  make -j"$JOBS" build_libs >/dev/null
  make install_dev >/dev/null 2>&1
  if [ "$PLATFORM" = win32 ]; then make install_runtime_libs >/dev/null 2>&1 || cp lib*.dll "$PREFIX/bin/"; fi
)

build_autotools() {
  local name="$1" version="$2"; shift 2
  echo "==> $name $version ($PLATFORM-$ARCH)"
  unpack "$(fetch "https://github.com/libimobiledevice/$name/releases/download/$version/$name-$version.tar.bz2")"
  (
    cd "$WORK/src/$name-$version"
    ./configure --host="$HOST" --prefix="$PREFIX" $LINK_MODE "$@" >/dev/null
    make -j"$JOBS" >/dev/null
    make install >/dev/null
  )
  cp "$WORK/src/$name-$version/COPYING" "$OUT/licenses/$name-COPYING.txt" 2>/dev/null || true
}

build_autotools libplist "$LIBPLIST_VERSION" --without-cython --without-tools --without-tests
build_autotools libimobiledevice-glue "$GLUE_VERSION"
build_autotools libusbmuxd "$USBMUXD_VERSION"
build_autotools libtatsu "$TATSU_VERSION"
build_autotools libimobiledevice "$LIMD_VERSION" --without-cython --without-readline --with-openssl
cp "$WORK/src/openssl-$OPENSSL_VERSION/LICENSE.txt" "$OUT/licenses/openssl-LICENSE.txt"

EXE=""
[ "$PLATFORM" = win32 ] && EXE=".exe"
for tool in $IOS_TOOLS; do
  cp "$PREFIX/bin/$tool$EXE" "$OUT/"
done

if [ "$PLATFORM" = darwin ]; then
  for tool in $IOS_TOOLS; do
    strip -x "$OUT/$tool"
    if otool -L "$OUT/$tool" | tail -n +2 | grep -Ev '^\s*(/usr/lib/|/System/Library/)' | grep -q .; then
      echo "$tool links a non-system library:" >&2; otool -L "$OUT/$tool" >&2; exit 1
    fi
    lipo -archs "$OUT/$tool" | grep -qw "$CLANG_ARCH" || { echo "$tool is not $CLANG_ARCH" >&2; exit 1; }
  done
else
  # Ship every non-Windows DLL the tools load so they run outside MSYS2.
  for tool in $IOS_TOOLS; do
    ldd "$OUT/$tool.exe" | awk '{print $3}' | grep -iE '^/(ucrt64|.*prefix)/' || true
  done | sort -u | while read -r dll; do cp -n "$dll" "$OUT/"; done
fi

echo "==> Android platform-tools (adb)"
ADB_ZIP="$(fetch "https://dl.google.com/android/repository/platform-tools-latest-$([ "$PLATFORM" = darwin ] && echo darwin || echo windows).zip")"
rm -rf "$WORK/platform-tools"
unzip -q -o "$ADB_ZIP" -d "$WORK"
if [ "$PLATFORM" = darwin ]; then
  lipo -archs "$WORK/platform-tools/adb" | grep -qw "$CLANG_ARCH" || { echo "adb is not $CLANG_ARCH" >&2; exit 1; }
  lipo "$WORK/platform-tools/adb" -thin "$CLANG_ARCH" -output "$OUT/adb" 2>/dev/null || cp "$WORK/platform-tools/adb" "$OUT/adb"
else
  cp "$WORK/platform-tools/adb.exe" "$WORK/platform-tools/AdbWinApi.dll" "$WORK/platform-tools/AdbWinUsbApi.dll" "$OUT/"
fi
cp "$WORK/platform-tools/NOTICE.txt" "$OUT/licenses/android-platform-tools-NOTICE.txt" 2>/dev/null || true

echo "$WANT_STAMP" > "$STAMP"
echo "Phone tools ready: $OUT"
ls -la "$OUT"
