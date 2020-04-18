/* eslint-disable no-undef */

(function initPortApi () {
  function writeArrayToMemory (array) {
    const byteLength = array.length * array.BYTES_PER_ELEMENT
    const pointer = Module._malloc(byteLength)
    const dataHeap = new Uint8Array(Module.HEAPU8.buffer, pointer, byteLength)
    dataHeap.set(new Uint8Array(array.buffer))
    return dataHeap.byteOffset
  }
  const WASM_API = {}
  WASM_API.addInt = Module._addInt
  // WASM_API.addInt = Module.cwrap('addInt', 'number', ['number', 'number'])
  WASM_API.sumInt = function (arr) {
    const sum = Module.cwrap('sumInt', 'number', ['number', 'number'])
    const pointer = writeArrayToMemory(new Int32Array(arr))
    const res = sum(pointer, arr.length)
    Module._free(pointer)
    return res
  }
  WASM_API.doubleIntArray = function (arr) {
    const doubleArray = Module.cwrap('doubleIntArray', null, ['number', 'number', 'number'])
    const intArray = new Int32Array(arr)
    const arrPointer = writeArrayToMemory(intArray)
    const resPointer = Module._malloc(intArray.length * intArray.BYTES_PER_ELEMENT)
    doubleArray(arrPointer, resPointer, arr.length)
    const res = new Int32Array(Module.HEAPU8.buffer, resPointer, arr.length)
    Module._free(arrPointer)
    Module._free(resPointer)
    return [...res]
  }
  WASM_API.benchMarkAdd = Module.cwrap('benchMarkAdd', 'number', ['number', 'number'])
  WASM_API.helloWorld = Module.cwrap('hello_world', 'string', [])
  Module.portAPI = WASM_API
  self.onmessage = (msg) => {
    if (msg.data && msg.data.type) {
      switch (msg.data.type) {
        case 'doubleIntArray': {
          const res = WASM_API.doubleIntArray(msg.data.array)
          self.postMessage({
            type: 'doubleIntArray',
            return: res
          })
          break
        }
      }
    }
  }
})()
