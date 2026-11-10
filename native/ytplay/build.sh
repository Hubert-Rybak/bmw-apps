#!/bin/sh
# Builds hrybak-ytplay.
#
#   native/ytplay/build.sh            for the head unit: x86-64, glibc 2.27, FFmpeg linked in statically
#                                     -> native/ytplay/out/hrybak-ytplay, copied to tools/hrybak-ytplay/
#   native/ytplay/build.sh host       for this machine (tests) -> native/ytplay/out/host/hrybak-ytplay
#                                     (the system's FFmpeg development packages when pkg-config finds them)
#   native/ytplay/build.sh target ffmpeg     only the FFmpeg libraries
#
# The head-unit build needs git, make, nasm and python3 with the "ziglang" package
# (pip install ziglang==0.13.0): zig is the C compiler and brings glibc 2.27's symbol versions, so no Docker
# and no old distribution is needed. FFmpeg is fetched at the tag below and configured without --enable-gpl
# and --enable-nonfree: LGPL-2.1-or-later.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
FFMPEG_TAG=${FFMPEG_TAG:-n7.1.5}
WORK=${YTPLAY_WORK:-$HERE/out/work}
MODE=${1:-target}
STAGE=${2:-all}
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 4)}
CFLAGS_OWN="-O2 -g0 -Wall -Wextra -Wno-unused-parameter -std=gnu11 -D_GNU_SOURCE"

mkdir -p "$WORK"

if [ "$MODE" = host ] && pkg-config --exists libavformat libavcodec libswscale libswresample libavutil 2>/dev/null; then
    OUT=$HERE/out/host
    mkdir -p "$OUT"
    cd "$HERE"
    # shellcheck disable=SC2046,SC2086
    ${CC:-cc} $CFLAGS_OWN $(pkg-config --cflags libavformat libavcodec libswscale libswresample libavutil) \
        -o "$OUT/hrybak-ytplay" src/*.c \
        $(pkg-config --libs libavformat libavcodec libswscale libswresample libavutil) -lpthread -lm -ldl
    echo "built $OUT/hrybak-ytplay (host, system FFmpeg)"
    exit 0
fi

SRC=${FFMPEG_SRC:-$WORK/ffmpeg-src}
if [ ! -f "$SRC/configure" ]; then
    git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg "$SRC"
fi

if [ "$MODE" = host ]; then
    CC=${CC:-cc}; AR=${AR:-ar}; RANLIB=${RANLIB:-ranlib}
    BUILD=$WORK/ffmpeg-host; OUT=$HERE/out/host
else
    ZIG=$(python3 -c "import os, ziglang; print(os.path.join(os.path.dirname(ziglang.__file__), 'zig'))")
    mkdir -p "$WORK/bin"
    printf '#!/bin/sh\nexec "%s" cc -target x86_64-linux-gnu.2.27 -fno-sanitize=undefined "$@"\n' "$ZIG" > "$WORK/bin/zig-cc"
    printf '#!/bin/sh\nexec "%s" ar "$@"\n' "$ZIG" > "$WORK/bin/zig-ar"
    printf '#!/bin/sh\nexec "%s" ranlib "$@"\n' "$ZIG" > "$WORK/bin/zig-ranlib"
    chmod +x "$WORK/bin/zig-cc" "$WORK/bin/zig-ar" "$WORK/bin/zig-ranlib"
    CC=$WORK/bin/zig-cc; AR=$WORK/bin/zig-ar; RANLIB=$WORK/bin/zig-ranlib
    BUILD=$WORK/ffmpeg-target; OUT=$HERE/out
fi
PREFIX=$BUILD/prefix

if [ ! -f "$PREFIX/lib/libavcodec.a" ]; then
    mkdir -p "$BUILD"
    cd "$BUILD"
    # Only what the player uses: MP4 / WebM in, H.264 / VP9 picture, AAC / Opus / MP3 sound, and the still
    # pictures of thumbnails (JPEG, WebP). No network code (the app hands the bytes over), no programs.
    "$SRC/configure" --prefix="$PREFIX" --cc="$CC" --ar="$AR" --ranlib="$RANLIB" --nm=nm --strip=strip \
        --enable-static --disable-shared --enable-pic \
        --disable-programs --disable-doc --disable-debug --disable-autodetect --disable-network \
        --disable-avdevice --disable-avfilter --disable-postproc \
        --disable-everything \
        --enable-pthreads \
        --enable-demuxer=mov,matroska \
        --enable-decoder=h264,vp9,aac,opus,mp3,mjpeg,webp \
        --enable-parser=h264,vp9,aac,opus,mpegaudio,mjpeg,webp \
        --enable-protocol=file \
        --enable-swscale --enable-swresample \
        --extra-cflags="-O2 -fno-strict-aliasing"
    # zig links against glibc 2.27, which still has sysctl(), but compiles with current headers, which have
    # dropped <sys/sysctl.h>: FFmpeg only uses it to count CPUs where sysconf() does the same
    sed -i 's/^#define HAVE_SYSCTL 1/#define HAVE_SYSCTL 0/' config.h
    make -j"$JOBS"
    make install
fi
[ "$STAGE" = ffmpeg ] && { echo "FFmpeg libraries in $PREFIX"; exit 0; }

mkdir -p "$OUT"
cd "$HERE"
LIBS="$PREFIX/lib/libavformat.a $PREFIX/lib/libavcodec.a $PREFIX/lib/libswresample.a $PREFIX/lib/libswscale.a $PREFIX/lib/libavutil.a -lpthread -lm -ldl"
# the head unit's loader is /lib/ld-linux-x86-64.so.2 (it has no /lib64)
LDFLAGS_OWN=
[ "$MODE" != host ] && LDFLAGS_OWN="-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2"
# shellcheck disable=SC2086
"$CC" $CFLAGS_OWN -I"$PREFIX/include" -o "$OUT/hrybak-ytplay" src/*.c $LIBS $LDFLAGS_OWN
if [ "$MODE" != host ]; then
    strip "$OUT/hrybak-ytplay"
    # what the head unit can load: its loader, its glibc (2.27), and only the C library's own parts
    B=$OUT/hrybak-ytplay
    interp=$(readelf -l "$B" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
    needed=$(readelf -d "$B" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort | tr '\n' ' ')
    newest=$(objdump -T "$B" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
    [ "$interp" = /lib/ld-linux-x86-64.so.2 ] || { echo "FAIL: interpreter $interp"; exit 1; }
    for l in $needed; do
        case $l in libc.so.6|libm.so.6|libpthread.so.0|libdl.so.2) ;; *) echo "FAIL: needs $l"; exit 1 ;; esac
    done
    [ "$(printf '%s\nGLIBC_2.27\n' "$newest" | sort -V | tail -1)" = GLIBC_2.27 ] || { echo "FAIL: needs $newest"; exit 1; }
    echo "target check: x86-64, $interp, needs $needed, glibc up to $newest"
    mkdir -p "$ROOT/tools/hrybak-ytplay"
    cp "$OUT/hrybak-ytplay" "$ROOT/tools/hrybak-ytplay/hrybak-ytplay"
    echo "built $OUT/hrybak-ytplay ($(wc -c < "$OUT/hrybak-ytplay") bytes), copied to tools/hrybak-ytplay/"
else
    echo "built $OUT/hrybak-ytplay (host, FFmpeg $FFMPEG_TAG)"
fi
