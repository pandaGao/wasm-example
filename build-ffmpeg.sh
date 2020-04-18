#!/usr/bin/env bash

COMMON_DEMUXERS=(matroska ogg avi mov flv mpegps mpegvideo data mp3 concat amr wav asf rm pcm_s16le dv mpegts h264 aac flac)

COMMON_DECODERS=(mpeg2video mpeg4 h264 hevc h263 rv40 rv20 dvvideo mpeg1video  mpegvideo tscc \
	vp8 vp9 theora \
	vorbis opus \
	mp3 ac3 aac cook pcm_s16le mp2 mp2float flac)

MP3_MUXERS=(mp3)
MP3_ENCODERS=(aac)

FFMPEG_CONFIGURE_ARGS="
  --cc=emcc \
  --ar=emar \
  --enable-cross-compile \
  --target-os=none \
  --cpu=generic \
  --arch=x86 \
	--disable-doc \
  --disable-runtime-cpudetect \
  --disable-asm \
  --disable-fast-unaligned \
  --disable-pthreads \
  --disable-w32threads \
  --disable-os2threads \
  --disable-debug \
  --disable-stripping \
  --disable-all \
  --enable-avformat \
	--enable-avcodec \
  --enable-avutil \
	--enable-shared \
	--enable-swscale \
  --enable-protocol=file \
  ${COMMON_DEMUXERS[@]/#/--enable-demuxer=} \
  ${COMMON_DECODERS[@]/#/--enable-decoder=} \
  ${MP3_MUXERS[@]/#/--enable-muxer=} \
  ${MP3_ENCODERS[@]/#/--enable-encoder=}
  "

function build_ffmpeg {
  echo "Start building ffmpeg..."
  echo ${FFMPEG_CONFIGURE_ARGS}
  cd FFmpeg
	emconfigure ./configure ${FFMPEG_CONFIGURE_ARGS}
	emmake make
  cd ..
  echo "Building complete!"
}

function build_jansson {
  echo "Start building jansson..."
  cd jansson
	emconfigure cmake .
  emmake make
  cd ..
  echo "Building complete!"
}

function build_wasm {
  echo "Start building wasm..."
  emcc src/wasm/converter.c \
    ./FFmpeg/libavformat/libavformat.a \
    ./FFmpeg/libavcodec/libavcodec.a \
    ./FFmpeg/libavutil/libavutil.a \
    ./jansson/lib/libjansson.a \
    -I./FFmpeg \
    -I./jansson/include/ \
    -I./jansson/src/ \
    --post-js src/wasm/converter-post.js \
    -s FORCE_FILESYSTEM=1 \
		-lworkerfs.js \
    -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall", "cwrap"]' \
    -s ASSERTIONS=1 \
    -s VERBOSE=0 \
    -s TOTAL_MEMORY=67108864 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s WASM=1 \
    -s BINARYEN=1 \
		--no-heap-copy \
    -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
    -O2 --memory-init-file 0 \
    -o ./public/media-info.js
}

case $1 in
  "ffmpeg")
    build_ffmpeg ;;
  "jansson")
    build_jansson ;;
  "wasm")
    build_wasm ;;
  *)
    build_jansson
    build_ffmpeg
    build_wasm
    ;;
esac