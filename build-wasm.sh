#!/bin/bash
eval $@

set -e

export OPTIMIZE="-O0"
export LDFLAGS="${OPTIMIZE}"
export CFLAGS="${OPTIMIZE}"
export CXXFLAGS="${OPTIMIZE}"

echo "============================================="
echo "Compiling wasm bindings"
echo "============================================="
(
  emcc \
    ./src/wasm/port.cpp \
    ${OPTIMIZE} -s WASM=0 \
    --memory-init-file 1\
    -s EXPORTED_FUNCTIONS='["_free", "_malloc"]' \
    -s EXTRA_EXPORTED_RUNTIME_METHODS='["cwrap"]' \
    --post-js ./src/wasm/port.js \
    -s ASSERTIONS=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -o ./public/example1.asm.js
)
(
  emcc \
    ./src/wasm/port.cpp \
    ${OPTIMIZE} -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_free", "_malloc"]' \
    -s EXTRA_EXPORTED_RUNTIME_METHODS='["cwrap"]' \
    --post-js ./src/wasm/port.js \
    -s ASSERTIONS=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -o ./public/example.out.js
)
echo "============================================="
echo "Compiling wasm bindings done"
echo "============================================="