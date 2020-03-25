// Copyright 2010 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module !== 'undefined' ? Module : {}

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {}
var key
for (key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key]
  }
}

var arguments_ = []
var thisProgram = './this.program'
var quit_ = function (status, toThrow) {
  throw toThrow
}

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

var ENVIRONMENT_IS_WEB = false
var ENVIRONMENT_IS_WORKER = false
var ENVIRONMENT_IS_NODE = false
var ENVIRONMENT_HAS_NODE = false
var ENVIRONMENT_IS_SHELL = false
ENVIRONMENT_IS_WEB = typeof window === 'object'
ENVIRONMENT_IS_WORKER = typeof importScripts === 'function'
// A web environment like Electron.js can have Node enabled, so we must
// distinguish between Node-enabled environments and Node environments per se.
// This will allow the former to do things like mount NODEFS.
// Extended check using process.versions fixes issue #8816.
// (Also makes redundant the original check that 'require' is a function.)
ENVIRONMENT_HAS_NODE = typeof process === 'object' && typeof process.versions === 'object' && typeof process.versions.node === 'string'
ENVIRONMENT_IS_NODE = ENVIRONMENT_HAS_NODE && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER
ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER

if (Module.ENVIRONMENT) {
  throw new Error('Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -s ENVIRONMENT=web or -s ENVIRONMENT=node)')
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = ''
function locateFile (path) {
  if (Module.locateFile) {
    return Module.locateFile(path, scriptDirectory)
  }
  return scriptDirectory + path
}

// Hooks that are implemented differently in different runtime environments.
var read_,
  readAsync,
  readBinary,
  setWindowTitle

var nodeFS
var nodePath

if (ENVIRONMENT_IS_NODE) {
  scriptDirectory = __dirname + '/'

  read_ = function shell_read (filename, binary) {
    if (!nodeFS) nodeFS = require('fs')
    if (!nodePath) nodePath = require('path')
    filename = nodePath.normalize(filename)
    return nodeFS.readFileSync(filename, binary ? null : 'utf8')
  }

  readBinary = function readBinary (filename) {
    var ret = read_(filename, true)
    if (!ret.buffer) {
      ret = new Uint8Array(ret)
    }
    assert(ret.buffer)
    return ret
  }

  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, '/')
  }

  arguments_ = process.argv.slice(2)

  if (typeof module !== 'undefined') {
    module.exports = Module
  }

  process.on('uncaughtException', function (ex) {
    // suppress ExitStatus exceptions from showing an error
    if (!(ex instanceof ExitStatus)) {
      throw ex
    }
  })

  process.on('unhandledRejection', abort)

  quit_ = function (status) {
    process.exit(status)
  }

  Module.inspect = function () { return '[Emscripten Module object]' }
} else
if (ENVIRONMENT_IS_SHELL) {
  if (typeof read !== 'undefined') {
    read_ = function shell_read (f) {
      return read(f)
    }
  }

  readBinary = function readBinary (f) {
    var data
    if (typeof readbuffer === 'function') {
      return new Uint8Array(readbuffer(f))
    }
    data = read(f, 'binary')
    assert(typeof data === 'object')
    return data
  }

  if (typeof scriptArgs !== 'undefined') {
    arguments_ = scriptArgs
  } else if (typeof arguments !== 'undefined') {
    arguments_ = arguments
  }

  if (typeof quit === 'function') {
    quit_ = function (status) {
      quit(status)
    }
  }

  if (typeof print !== 'undefined') {
    // Prefer to use print/printErr where they exist, as they usually work better.
    if (typeof console === 'undefined') console = {}
    console.log = print
    console.warn = console.error = typeof printErr !== 'undefined' ? printErr : print
  }
} else

// Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_HAS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
    scriptDirectory = self.location.href
  } else if (document.currentScript) { // web
    scriptDirectory = document.currentScript.src
  }
  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
  // otherwise, slice off the final part of the url to find the script directory.
  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
  // and scriptDirectory will correctly be replaced with an empty string.
  if (scriptDirectory.indexOf('blob:') !== 0) {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf('/') + 1)
  } else {
    scriptDirectory = ''
  }

  // Differentiate the Web Worker from the Node Worker case, as reading must
  // be done differently.
  {
    read_ = function shell_read (url) {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', url, false)
      xhr.send(null)
      return xhr.responseText
    }

    if (ENVIRONMENT_IS_WORKER) {
      readBinary = function readBinary (url) {
        var xhr = new XMLHttpRequest()
        xhr.open('GET', url, false)
        xhr.responseType = 'arraybuffer'
        xhr.send(null)
        return new Uint8Array(xhr.response)
      }
    }

    readAsync = function readAsync (url, onload, onerror) {
      var xhr = new XMLHttpRequest()
      xhr.open('GET', url, true)
      xhr.responseType = 'arraybuffer'
      xhr.onload = function xhr_onload () {
        if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
          onload(xhr.response)
          return
        }
        onerror()
      }
      xhr.onerror = onerror
      xhr.send(null)
    }
  }

  setWindowTitle = function (title) { document.title = title }
} else {
  throw new Error('environment detection error')
}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
var out = Module.print || console.log.bind(console)
var err = Module.printErr || console.warn.bind(console)

// Merge back in the overrides
for (key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key]
  }
}
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used e.g. in memoryInitializerRequest, which is a large typed array.
moduleOverrides = null

// Emit code to handle expected values on the Module object. This applies Module.x
// to the proper local x. This has two benefits: first, we only emit it if it is
// expected to arrive, and second, by using a local everywhere else that can be
// minified.
if (Module.arguments) arguments_ = Module.arguments; if (!Object.getOwnPropertyDescriptor(Module, 'arguments')) Object.defineProperty(Module, 'arguments', { configurable: true, get: function () { abort('Module.arguments has been replaced with plain arguments_') } })
if (Module.thisProgram) thisProgram = Module.thisProgram; if (!Object.getOwnPropertyDescriptor(Module, 'thisProgram')) Object.defineProperty(Module, 'thisProgram', { configurable: true, get: function () { abort('Module.thisProgram has been replaced with plain thisProgram') } })
if (Module.quit) quit_ = Module.quit; if (!Object.getOwnPropertyDescriptor(Module, 'quit')) Object.defineProperty(Module, 'quit', { configurable: true, get: function () { abort('Module.quit has been replaced with plain quit_') } })

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message
// Assertions on removed incoming Module JS APIs.
assert(typeof Module.memoryInitializerPrefixURL === 'undefined', 'Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead')
assert(typeof Module.pthreadMainPrefixURL === 'undefined', 'Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead')
assert(typeof Module.cdInitializerPrefixURL === 'undefined', 'Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead')
assert(typeof Module.filePackagePrefixURL === 'undefined', 'Module.filePackagePrefixURL option was removed, use Module.locateFile instead')
assert(typeof Module.read === 'undefined', 'Module.read option was removed (modify read_ in JS)')
assert(typeof Module.readAsync === 'undefined', 'Module.readAsync option was removed (modify readAsync in JS)')
assert(typeof Module.readBinary === 'undefined', 'Module.readBinary option was removed (modify readBinary in JS)')
assert(typeof Module.setWindowTitle === 'undefined', 'Module.setWindowTitle option was removed (modify setWindowTitle in JS)')
if (!Object.getOwnPropertyDescriptor(Module, 'read')) Object.defineProperty(Module, 'read', { configurable: true, get: function () { abort('Module.read has been replaced with plain read_') } })
if (!Object.getOwnPropertyDescriptor(Module, 'readAsync')) Object.defineProperty(Module, 'readAsync', { configurable: true, get: function () { abort('Module.readAsync has been replaced with plain readAsync') } })
if (!Object.getOwnPropertyDescriptor(Module, 'readBinary')) Object.defineProperty(Module, 'readBinary', { configurable: true, get: function () { abort('Module.readBinary has been replaced with plain readBinary') } })
// TODO: add when SDL2 is fixed if (!Object.getOwnPropertyDescriptor(Module, 'setWindowTitle')) Object.defineProperty(Module, 'setWindowTitle', { configurable: true, get: function() { abort('Module.setWindowTitle has been replaced with plain setWindowTitle') } });
var IDBFS = 'IDBFS is no longer included by default; build with -lidbfs.js'
var PROXYFS = 'PROXYFS is no longer included by default; build with -lproxyfs.js'
var WORKERFS = 'WORKERFS is no longer included by default; build with -lworkerfs.js'
var NODEFS = 'NODEFS is no longer included by default; build with -lnodefs.js'

// TODO remove when SDL2 is fixed (also see above)

// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// {{PREAMBLE_ADDITIONS}}

var STACK_ALIGN = 16

// stack management, and other functionality that is provided by the compiled code,
// should not be used before it is ready
stackSave = stackRestore = stackAlloc = function () {
  abort('cannot use the stack before compiled code is ready to run, and has provided stack access')
}

function staticAlloc (size) {
  abort('staticAlloc is no longer available at runtime; instead, perform static allocations at compile time (using makeStaticAlloc)')
}

function dynamicAlloc (size) {
  assert(DYNAMICTOP_PTR)
  var ret = HEAP32[DYNAMICTOP_PTR >> 2]
  var end = (ret + size + 15) & -16
  if (end > _emscripten_get_heap_size()) {
    abort('failure to dynamicAlloc - memory growth etc. is not supported there, call malloc/sbrk directly')
  }
  HEAP32[DYNAMICTOP_PTR >> 2] = end
  return ret
}

function alignMemory (size, factor) {
  if (!factor) factor = STACK_ALIGN // stack alignment (16-byte) by default
  return Math.ceil(size / factor) * factor
}

function getNativeTypeSize (type) {
  switch (type) {
    case 'i1': case 'i8': return 1
    case 'i16': return 2
    case 'i32': return 4
    case 'i64': return 8
    case 'float': return 4
    case 'double': return 8
    default: {
      if (type[type.length - 1] === '*') {
        return 4 // A pointer
      } else if (type[0] === 'i') {
        var bits = parseInt(type.substr(1))
        assert(bits % 8 === 0, 'getNativeTypeSize invalid bits ' + bits + ', type ' + type)
        return bits / 8
      } else {
        return 0
      }
    }
  }
}

function warnOnce (text) {
  if (!warnOnce.shown) warnOnce.shown = {}
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1
    err(text)
  }
}

var asm2wasmImports = { // special asm2wasm imports
  'f64-rem': function (x, y) {
    return x % y
  },
  debugger: function () {
    debugger
  }
}

var jsCallStartIndex = 1
var functionPointers = new Array(0)

// 'sig' parameter is required for the llvm backend but only when func is not
// already a WebAssembly function.
function addFunction (func, sig) {
  assert(typeof func !== 'undefined')

  var base = 0
  for (var i = base; i < base + 0; i++) {
    if (!functionPointers[i]) {
      functionPointers[i] = func
      return jsCallStartIndex + i
    }
  }
  throw 'Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.'
}

function removeFunction (index) {
  functionPointers[index - jsCallStartIndex] = null
}

var funcWrappers = {}

function getFuncWrapper (func, sig) {
  if (!func) return // on null pointer, return undefined
  assert(sig)
  if (!funcWrappers[sig]) {
    funcWrappers[sig] = {}
  }
  var sigCache = funcWrappers[sig]
  if (!sigCache[func]) {
    // optimize away arguments usage in common cases
    if (sig.length === 1) {
      sigCache[func] = function dynCall_wrapper () {
        return dynCall(sig, func)
      }
    } else if (sig.length === 2) {
      sigCache[func] = function dynCall_wrapper (arg) {
        return dynCall(sig, func, [arg])
      }
    } else {
      // general case
      sigCache[func] = function dynCall_wrapper () {
        return dynCall(sig, func, Array.prototype.slice.call(arguments))
      }
    }
  }
  return sigCache[func]
}

function makeBigInt (low, high, unsigned) {
  return unsigned ? ((+((low >>> 0))) + ((+((high >>> 0))) * 4294967296.0)) : ((+((low >>> 0))) + ((+((high | 0))) * 4294967296.0))
}

function dynCall (sig, ptr, args) {
  if (args && args.length) {
    assert(args.length == sig.length - 1)
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'')
    return Module['dynCall_' + sig].apply(null, [ptr].concat(args))
  } else {
    assert(sig.length == 1)
    assert(('dynCall_' + sig) in Module, 'bad function pointer type - no table for sig \'' + sig + '\'')
    return Module['dynCall_' + sig].call(null, ptr)
  }
}

var tempRet0 = 0

var setTempRet0 = function (value) {
  tempRet0 = value
}

var getTempRet0 = function () {
  return tempRet0
}

function getCompilerSetting (name) {
  throw 'You must build with -s RETAIN_COMPILER_SETTINGS=1 for getCompilerSetting or emscripten_get_compiler_setting to work'
}

var Runtime = {
  // helpful errors
  getTempRet0: function () { abort('getTempRet0() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  staticAlloc: function () { abort('staticAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') },
  stackAlloc: function () { abort('stackAlloc() is now a top-level function, after removing the Runtime object. Remove "Runtime."') }
}

// The address globals begin at. Very low in memory, for code size and optimization opportunities.
// Above 0 is static memory, starting with globals.
// Then the stack.
// Then 'dynamic' memory for sbrk.
var GLOBAL_BASE = 8

// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

var wasmBinary; if (Module.wasmBinary) wasmBinary = Module.wasmBinary; if (!Object.getOwnPropertyDescriptor(Module, 'wasmBinary')) Object.defineProperty(Module, 'wasmBinary', { configurable: true, get: function () { abort('Module.wasmBinary has been replaced with plain wasmBinary') } })
var noExitRuntime; if (Module.noExitRuntime) noExitRuntime = Module.noExitRuntime; if (!Object.getOwnPropertyDescriptor(Module, 'noExitRuntime')) Object.defineProperty(Module, 'noExitRuntime', { configurable: true, get: function () { abort('Module.noExitRuntime has been replaced with plain noExitRuntime') } })

// In MINIMAL_RUNTIME, setValue() and getValue() are only available when building with safe heap enabled, for heap safety checking.
// In traditional runtime, setValue() and getValue() are always available (although their use is highly discouraged due to perf penalties)

/** @type {function(number, number, string, boolean=)} */
function setValue (ptr, value, type, noSafe) {
  type = type || 'i8'
  if (type.charAt(type.length - 1) === '*') type = 'i32' // pointers are 32-bit
  switch (type) {
    case 'i1': HEAP8[((ptr) >> 0)] = value; break
    case 'i8': HEAP8[((ptr) >> 0)] = value; break
    case 'i16': HEAP16[((ptr) >> 1)] = value; break
    case 'i32': HEAP32[((ptr) >> 2)] = value; break
    case 'i64': (tempI64 = [value >>> 0, (tempDouble = value, (+(Math_abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math_min((+(Math_floor((tempDouble) / 4294967296.0))), 4294967295.0)) | 0) >>> 0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble))) >>> 0)) / 4294967296.0))))) >>> 0) : 0)], HEAP32[((ptr) >> 2)] = tempI64[0], HEAP32[(((ptr) + (4)) >> 2)] = tempI64[1]); break
    case 'float': HEAPF32[((ptr) >> 2)] = value; break
    case 'double': HEAPF64[((ptr) >> 3)] = value; break
    default: abort('invalid type for setValue: ' + type)
  }
}

/** @type {function(number, string, boolean=)} */
function getValue (ptr, type, noSafe) {
  type = type || 'i8'
  if (type.charAt(type.length - 1) === '*') type = 'i32' // pointers are 32-bit
  switch (type) {
    case 'i1': return HEAP8[((ptr) >> 0)]
    case 'i8': return HEAP8[((ptr) >> 0)]
    case 'i16': return HEAP16[((ptr) >> 1)]
    case 'i32': return HEAP32[((ptr) >> 2)]
    case 'i64': return HEAP32[((ptr) >> 2)]
    case 'float': return HEAPF32[((ptr) >> 2)]
    case 'double': return HEAPF64[((ptr) >> 3)]
    default: abort('invalid type for getValue: ' + type)
  }
  return null
}

// Wasm globals

var wasmMemory

// In fastcomp asm.js, we don't need a wasm Table at all.
// In the wasm backend, we polyfill the WebAssembly object,
// so this creates a (non-native-wasm) table for us.

//= =======================================
// Runtime essentials
//= =======================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS = 0

/** @type {function(*, string=)} */
function assert (condition, text) {
  if (!condition) {
    abort('Assertion failed: ' + text)
  }
}

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc (ident) {
  var func = Module['_' + ident] // closure exported function
  assert(func, 'Cannot call unknown function ' + ident + ', make sure it is exported')
  return func
}

// C calling interface.
function ccall (ident, returnType, argTypes, args, opts) {
  // For fast lookup of conversion functions
  var toC = {
    string: function (str) {
      var ret = 0
      if (str !== null && str !== undefined && str !== 0) { // null string
        // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
        var len = (str.length << 2) + 1
        ret = stackAlloc(len)
        stringToUTF8(str, ret, len)
      }
      return ret
    },
    array: function (arr) {
      var ret = stackAlloc(arr.length)
      writeArrayToMemory(arr, ret)
      return ret
    }
  }

  function convertReturnValue (ret) {
    if (returnType === 'string') return UTF8ToString(ret)
    if (returnType === 'boolean') return Boolean(ret)
    return ret
  }

  var func = getCFunc(ident)
  var cArgs = []
  var stack = 0
  assert(returnType !== 'array', 'Return type should not be "array".')
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]]
      if (converter) {
        if (stack === 0) stack = stackSave()
        cArgs[i] = converter(args[i])
      } else {
        cArgs[i] = args[i]
      }
    }
  }
  var ret = func.apply(null, cArgs)

  ret = convertReturnValue(ret)
  if (stack !== 0) stackRestore(stack)
  return ret
}

function cwrap (ident, returnType, argTypes, opts) {
  return function () {
    return ccall(ident, returnType, argTypes, arguments, opts)
  }
}

var ALLOC_NORMAL = 0 // Tries to use _malloc()
var ALLOC_STACK = 1 // Lives for the duration of the current function call
var ALLOC_DYNAMIC = 2 // Cannot be freed except through sbrk
var ALLOC_NONE = 3 // Do not allocate

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data, or a number. If a number, then the size of the block to allocate,
//        in *bytes* (note that this is sometimes confusing: the next parameter does not
//        affect this!)
// @types: Either an array of types, one for each byte (or 0 if no type at that position),
//         or a single type which is used for the entire block. This only matters if there
//         is initial data - if @slab is a number, then this does not matter at all and is
//         ignored.
// @allocator: How to allocate memory, see ALLOC_*
/** @type {function((TypedArray|Array<number>|number), string, number, number=)} */
function allocate (slab, types, allocator, ptr) {
  var zeroinit, size
  if (typeof slab === 'number') {
    zeroinit = true
    size = slab
  } else {
    zeroinit = false
    size = slab.length
  }

  var singleType = typeof types === 'string' ? types : null

  var ret
  if (allocator == ALLOC_NONE) {
    ret = ptr
  } else {
    ret = [_malloc,
      stackAlloc,
      dynamicAlloc][allocator](Math.max(size, singleType ? 1 : types.length))
  }

  if (zeroinit) {
    var stop
    ptr = ret
    assert((ret & 3) == 0)
    stop = ret + (size & ~3)
    for (; ptr < stop; ptr += 4) {
      HEAP32[((ptr) >> 2)] = 0
    }
    stop = ret + size
    while (ptr < stop) {
      HEAP8[((ptr++) >> 0)] = 0
    }
    return ret
  }

  if (singleType === 'i8') {
    if (slab.subarray || slab.slice) {
      HEAPU8.set(/** @type {!Uint8Array} */ (slab), ret)
    } else {
      HEAPU8.set(new Uint8Array(slab), ret)
    }
    return ret
  }

  var i = 0; var type; var typeSize; var previousType
  while (i < size) {
    var curr = slab[i]

    type = singleType || types[i]
    if (type === 0) {
      i++
      continue
    }
    assert(type, 'Must know what type to store in allocate!')

    if (type == 'i64') type = 'i32' // special case: we have one i32 here, and one i32 later

    setValue(ret + i, curr, type)

    // no need to look up size unless type changes, so cache it
    if (previousType !== type) {
      typeSize = getNativeTypeSize(type)
      previousType = type
    }
    i += typeSize
  }

  return ret
}

// Allocate memory during any stage of startup - static memory early on, dynamic memory later, malloc when ready
function getMemory (size) {
  if (!runtimeInitialized) return dynamicAlloc(size)
  return _malloc(size)
}

/** @type {function(number, number=)} */
function Pointer_stringify (ptr, length) {
  abort('this function has been removed - you should use UTF8ToString(ptr, maxBytesToRead) instead!')
}

// Given a pointer 'ptr' to a null-terminated ASCII-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

function AsciiToString (ptr) {
  var str = ''
  while (1) {
    var ch = HEAPU8[((ptr++) >> 0)]
    if (!ch) return str
    str += String.fromCharCode(ch)
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in ASCII form. The copy will require at most str.length+1 bytes of space in the HEAP.

function stringToAscii (str, outPtr) {
  return writeAsciiToMemory(str, outPtr, false)
}

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the given array that contains uint8 values, returns
// a copy of that string as a Javascript String object.

var UTF8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf8') : undefined

/**
 * @param {number} idx
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ArrayToString (u8Array, idx, maxBytesToRead) {
  var endIdx = idx + maxBytesToRead
  var endPtr = idx
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  // (As a tiny code save trick, compare endPtr against endIdx using a negation, so that undefined means Infinity)
  while (u8Array[endPtr] && !(endPtr >= endIdx)) ++endPtr

  if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(u8Array.subarray(idx, endPtr))
  } else {
    var str = ''
    // If building with TextDecoder, we have already computed the string length above, so test loop end condition against that
    while (idx < endPtr) {
      // For UTF8 byte structure, see:
      // http://en.wikipedia.org/wiki/UTF-8#Description
      // https://www.ietf.org/rfc/rfc2279.txt
      // https://tools.ietf.org/html/rfc3629
      var u0 = u8Array[idx++]
      if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue }
      var u1 = u8Array[idx++] & 63
      if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue }
      var u2 = u8Array[idx++] & 63
      if ((u0 & 0xF0) == 0xE0) {
        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2
      } else {
        if ((u0 & 0xF8) != 0xF0) warnOnce('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string on the asm.js/wasm heap to a JS string!')
        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (u8Array[idx++] & 63)
      }

      if (u0 < 0x10000) {
        str += String.fromCharCode(u0)
      } else {
        var ch = u0 - 0x10000
        str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF))
      }
    }
  }
  return str
}

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the emscripten HEAP, returns a
// copy of that string as a Javascript String object.
// maxBytesToRead: an optional length that specifies the maximum number of bytes to read. You can omit
//                 this parameter to scan the string until the first \0 byte. If maxBytesToRead is
//                 passed, and the string at [ptr, ptr+maxBytesToReadr[ contains a null byte in the
//                 middle, then the string will cut short at that byte index (i.e. maxBytesToRead will
//                 not produce a string of exact length [ptr, ptr+maxBytesToRead[)
//                 N.B. mixing frequent uses of UTF8ToString() with and without maxBytesToRead may
//                 throw JS JIT optimizations off, so it is worth to consider consistently using one
//                 style or the other.
/**
 * @param {number} ptr
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ToString (ptr, maxBytesToRead) {
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : ''
}

// Copies the given Javascript String object 'str' to the given byte array at address 'outIdx',
// encoded in UTF8 form and null-terminated. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outU8Array: the array to copy to. Each index in this array is assumed to be one 8-byte element.
//   outIdx: The starting offset in the array to begin the copying.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array.
//                    This count should include the null terminator,
//                    i.e. if maxBytesToWrite=1, only the null terminator will be written and nothing else.
//                    maxBytesToWrite=0 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8Array (str, outU8Array, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) // Parameter maxBytesToWrite is not optional. Negative values, 0, null, undefined and false each don't write out any bytes.
  { return 0 }

  var startIdx = outIdx
  var endIdx = outIdx + maxBytesToWrite - 1 // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
    var u = str.charCodeAt(i) // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) {
      var u1 = str.charCodeAt(++i)
      u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF)
    }
    if (u <= 0x7F) {
      if (outIdx >= endIdx) break
      outU8Array[outIdx++] = u
    } else if (u <= 0x7FF) {
      if (outIdx + 1 >= endIdx) break
      outU8Array[outIdx++] = 0xC0 | (u >> 6)
      outU8Array[outIdx++] = 0x80 | (u & 63)
    } else if (u <= 0xFFFF) {
      if (outIdx + 2 >= endIdx) break
      outU8Array[outIdx++] = 0xE0 | (u >> 12)
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63)
      outU8Array[outIdx++] = 0x80 | (u & 63)
    } else {
      if (outIdx + 3 >= endIdx) break
      if (u >= 0x200000) warnOnce('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to an UTF-8 string on the asm.js/wasm heap! (Valid unicode code points should be in range 0-0x1FFFFF).')
      outU8Array[outIdx++] = 0xF0 | (u >> 18)
      outU8Array[outIdx++] = 0x80 | ((u >> 12) & 63)
      outU8Array[outIdx++] = 0x80 | ((u >> 6) & 63)
      outU8Array[outIdx++] = 0x80 | (u & 63)
    }
  }
  // Null-terminate the pointer to the buffer.
  outU8Array[outIdx] = 0
  return outIdx - startIdx
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF8 form. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8 (str, outPtr, maxBytesToWrite) {
  assert(typeof maxBytesToWrite === 'number', 'stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!')
  return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite)
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF8 byte array, EXCLUDING the null terminator byte.
function lengthBytesUTF8 (str) {
  var len = 0
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var u = str.charCodeAt(i) // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF)
    if (u <= 0x7F) ++len
    else if (u <= 0x7FF) len += 2
    else if (u <= 0xFFFF) len += 3
    else len += 4
  }
  return len
}

// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

var UTF16Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : undefined
function UTF16ToString (ptr) {
  assert(ptr % 2 == 0, 'Pointer passed to UTF16ToString must be aligned to two bytes!')
  var endPtr = ptr
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  var idx = endPtr >> 1
  while (HEAP16[idx]) ++idx
  endPtr = idx << 1

  if (endPtr - ptr > 32 && UTF16Decoder) {
    return UTF16Decoder.decode(HEAPU8.subarray(ptr, endPtr))
  } else {
    var i = 0

    var str = ''
    while (1) {
      var codeUnit = HEAP16[(((ptr) + (i * 2)) >> 1)]
      if (codeUnit == 0) return str
      ++i
      // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
      str += String.fromCharCode(codeUnit)
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16 form. The copy will require at most str.length*4+2 bytes of space in the HEAP.
// Use the function lengthBytesUTF16() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=2, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<2 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF16 (str, outPtr, maxBytesToWrite) {
  assert(outPtr % 2 == 0, 'Pointer passed to stringToUTF16 must be aligned to two bytes!')
  assert(typeof maxBytesToWrite === 'number', 'stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!')
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF
  }
  if (maxBytesToWrite < 2) return 0
  maxBytesToWrite -= 2 // Null terminator.
  var startPtr = outPtr
  var numCharsToWrite = (maxBytesToWrite < str.length * 2) ? (maxBytesToWrite / 2) : str.length
  for (var i = 0; i < numCharsToWrite; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i) // possibly a lead surrogate
    HEAP16[((outPtr) >> 1)] = codeUnit
    outPtr += 2
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[((outPtr) >> 1)] = 0
  return outPtr - startPtr
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF16 (str) {
  return str.length * 2
}

function UTF32ToString (ptr) {
  assert(ptr % 4 == 0, 'Pointer passed to UTF32ToString must be aligned to four bytes!')
  var i = 0

  var str = ''
  while (1) {
    var utf32 = HEAP32[(((ptr) + (i * 4)) >> 2)]
    if (utf32 == 0) { return str }
    ++i
    // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    if (utf32 >= 0x10000) {
      var ch = utf32 - 0x10000
      str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF))
    } else {
      str += String.fromCharCode(utf32)
    }
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32 form. The copy will require at most str.length*4+4 bytes of space in the HEAP.
// Use the function lengthBytesUTF32() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=4, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<4 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF32 (str, outPtr, maxBytesToWrite) {
  assert(outPtr % 4 == 0, 'Pointer passed to stringToUTF32 must be aligned to four bytes!')
  assert(typeof maxBytesToWrite === 'number', 'stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!')
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF
  }
  if (maxBytesToWrite < 4) return 0
  var startPtr = outPtr
  var endPtr = startPtr + maxBytesToWrite - 4
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i) // possibly a lead surrogate
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
      var trailSurrogate = str.charCodeAt(++i)
      codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF)
    }
    HEAP32[((outPtr) >> 2)] = codeUnit
    outPtr += 4
    if (outPtr + 4 > endPtr) break
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[((outPtr) >> 2)] = 0
  return outPtr - startPtr
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF32 (str) {
  var len = 0
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) ++i // possibly a lead surrogate, so skip over the tail surrogate.
    len += 4
  }

  return len
}

// Allocate heap space for a JS string, and write it there.
// It is the responsibility of the caller to free() that memory.
function allocateUTF8 (str) {
  var size = lengthBytesUTF8(str) + 1
  var ret = _malloc(size)
  if (ret) stringToUTF8Array(str, HEAP8, ret, size)
  return ret
}

// Allocate stack space for a JS string, and write it there.
function allocateUTF8OnStack (str) {
  var size = lengthBytesUTF8(str) + 1
  var ret = stackAlloc(size)
  stringToUTF8Array(str, HEAP8, ret, size)
  return ret
}

// Deprecated: This function should not be called because it is unsafe and does not provide
// a maximum length limit of how many bytes it is allowed to write. Prefer calling the
// function stringToUTF8Array() instead, which takes in a maximum length that can be used
// to be secure from out of bounds writes.
/** @deprecated */
function writeStringToMemory (string, buffer, dontAddNull) {
  warnOnce('writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!')

  var /** @type {number} */ lastChar, /** @type {number} */ end
  if (dontAddNull) {
    // stringToUTF8Array always appends null. If we don't want to do that, remember the
    // character that existed at the location where the null will be placed, and restore
    // that after the write (below).
    end = buffer + lengthBytesUTF8(string)
    lastChar = HEAP8[end]
  }
  stringToUTF8(string, buffer, Infinity)
  if (dontAddNull) HEAP8[end] = lastChar // Restore the value under the null character.
}

function writeArrayToMemory (array, buffer) {
  assert(array.length >= 0, 'writeArrayToMemory array must have a length (should be an array or typed array)')
  HEAP8.set(array, buffer)
}

function writeAsciiToMemory (str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; ++i) {
    assert(str.charCodeAt(i) === str.charCodeAt(i) & 0xff)
    HEAP8[((buffer++) >> 0)] = str.charCodeAt(i)
  }
  // Null-terminate the pointer to the HEAP.
  if (!dontAddNull) HEAP8[((buffer) >> 0)] = 0
}

// Memory management

var PAGE_SIZE = 16384
var WASM_PAGE_SIZE = 65536
var ASMJS_PAGE_SIZE = 16777216

function alignUp (x, multiple) {
  if (x % multiple > 0) {
    x += multiple - (x % multiple)
  }
  return x
}

var HEAP,
  /** @type {ArrayBuffer} */
  buffer,
  /** @type {Int8Array} */
  HEAP8,
  /** @type {Uint8Array} */
  HEAPU8,
  /** @type {Int16Array} */
  HEAP16,
  /** @type {Uint16Array} */
  HEAPU16,
  /** @type {Int32Array} */
  HEAP32,
  /** @type {Uint32Array} */
  HEAPU32,
  /** @type {Float32Array} */
  HEAPF32,
  /** @type {Float64Array} */
  HEAPF64

function updateGlobalBufferAndViews (buf) {
  buffer = buf
  Module.HEAP8 = HEAP8 = new Int8Array(buf)
  Module.HEAP16 = HEAP16 = new Int16Array(buf)
  Module.HEAP32 = HEAP32 = new Int32Array(buf)
  Module.HEAPU8 = HEAPU8 = new Uint8Array(buf)
  Module.HEAPU16 = HEAPU16 = new Uint16Array(buf)
  Module.HEAPU32 = HEAPU32 = new Uint32Array(buf)
  Module.HEAPF32 = HEAPF32 = new Float32Array(buf)
  Module.HEAPF64 = HEAPF64 = new Float64Array(buf)
}

var STATIC_BASE = 8
var STACK_BASE = 1936
var STACKTOP = STACK_BASE
var STACK_MAX = 5244816
var DYNAMIC_BASE = 5244816
var DYNAMICTOP_PTR = 1744

assert(STACK_BASE % 16 === 0, 'stack must start aligned')
assert(DYNAMIC_BASE % 16 === 0, 'heap must start aligned')

var TOTAL_STACK = 5242880
if (Module.TOTAL_STACK) assert(TOTAL_STACK === Module.TOTAL_STACK, 'the stack size can no longer be determined at runtime')

var INITIAL_TOTAL_MEMORY = Module.TOTAL_MEMORY || 16777216; if (!Object.getOwnPropertyDescriptor(Module, 'TOTAL_MEMORY')) Object.defineProperty(Module, 'TOTAL_MEMORY', { configurable: true, get: function () { abort('Module.TOTAL_MEMORY has been replaced with plain INITIAL_TOTAL_MEMORY') } })

assert(INITIAL_TOTAL_MEMORY >= TOTAL_STACK, 'TOTAL_MEMORY should be larger than TOTAL_STACK, was ' + INITIAL_TOTAL_MEMORY + '! (TOTAL_STACK=' + TOTAL_STACK + ')')

// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && Int32Array.prototype.subarray !== undefined && Int32Array.prototype.set !== undefined,
  'JS engine does not provide full typed array support')

// In standalone mode, the wasm creates the memory, and the user can't provide it.
// In non-standalone/normal mode, we create the memory here.

// Create the main memory. (Note: this isn't used in STANDALONE_WASM mode since the wasm
// memory is created in the wasm, not in JS.)

if (Module.buffer) {
  buffer = Module.buffer
} else {
  buffer = new ArrayBuffer(INITIAL_TOTAL_MEMORY)
}

// If the user provides an incorrect length, just use that length instead rather than providing the user to
// specifically provide the memory length with Module['TOTAL_MEMORY'].
INITIAL_TOTAL_MEMORY = buffer.byteLength
updateGlobalBufferAndViews(buffer)

HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE

// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie () {
  assert((STACK_MAX & 3) == 0)
  HEAPU32[(STACK_MAX >> 2) - 1] = 0x02135467
  HEAPU32[(STACK_MAX >> 2) - 2] = 0x89BACDFE
  // Also test the global address 0 for integrity.
  // We don't do this with ASan because ASan does its own checks for this.
  HEAP32[0] = 0x63736d65 /* 'emsc' */
}

function checkStackCookie () {
  var cookie1 = HEAPU32[(STACK_MAX >> 2) - 1]
  var cookie2 = HEAPU32[(STACK_MAX >> 2) - 2]
  if (cookie1 != 0x02135467 || cookie2 != 0x89BACDFE) {
    abort('Stack overflow! Stack cookie has been overwritten, expected hex dwords 0x89BACDFE and 0x02135467, but received 0x' + cookie2.toString(16) + ' ' + cookie1.toString(16))
  }
  // Also test the global address 0 for integrity.
  // We don't do this with ASan because ASan does its own checks for this.
  if (HEAP32[0] !== 0x63736d65 /* 'emsc' */) abort('Runtime error: The application has corrupted its heap memory area (address zero)!')
}

function abortStackOverflow (allocSize) {
  abort('Stack overflow! Attempted to allocate ' + allocSize + ' bytes on the stack, but stack has only ' + (STACK_MAX - stackSave() + allocSize) + ' bytes available!')
}

// Endianness check (note: assumes compiler arch was little-endian)
(function () {
  var h16 = new Int16Array(1)
  var h8 = new Int8Array(h16.buffer)
  h16[0] = 0x6373
  if (h8[0] !== 0x73 || h8[1] !== 0x63) throw 'Runtime error: expected the system to be little-endian!'
})()

function abortFnPtrError (ptr, sig) {
  abort('Invalid function pointer ' + ptr + " called with signature '" + sig + "'. Perhaps this is an invalid value (e.g. caused by calling a virtual method on a NULL pointer)? Or calling a function with an incorrect type, which will fail? (it is worth building your source files with -Werror (warnings are errors), as warnings can indicate undefined behavior which can cause this). Build with ASSERTIONS=2 for more info.")
}

function callRuntimeCallbacks (callbacks) {
  while (callbacks.length > 0) {
    var callback = callbacks.shift()
    if (typeof callback === 'function') {
      callback()
      continue
    }
    var func = callback.func
    if (typeof func === 'number') {
      if (callback.arg === undefined) {
        Module.dynCall_v(func)
      } else {
        Module.dynCall_vi(func, callback.arg)
      }
    } else {
      func(callback.arg === undefined ? null : callback.arg)
    }
  }
}

var __ATPRERUN__ = [] // functions called before the runtime is initialized
var __ATINIT__ = [] // functions called during startup
var __ATMAIN__ = [] // functions called when main() is to be run
var __ATEXIT__ = [] // functions called during shutdown
var __ATPOSTRUN__ = [] // functions called after the main() is called

var runtimeInitialized = false
var runtimeExited = false

function preRun () {
  if (Module.preRun) {
    if (typeof Module.preRun === 'function') Module.preRun = [Module.preRun]
    while (Module.preRun.length) {
      addOnPreRun(Module.preRun.shift())
    }
  }

  callRuntimeCallbacks(__ATPRERUN__)
}

function initRuntime () {
  checkStackCookie()
  assert(!runtimeInitialized)
  runtimeInitialized = true

  callRuntimeCallbacks(__ATINIT__)
}

function preMain () {
  checkStackCookie()

  callRuntimeCallbacks(__ATMAIN__)
}

function exitRuntime () {
  checkStackCookie()
  runtimeExited = true
}

function postRun () {
  checkStackCookie()

  if (Module.postRun) {
    if (typeof Module.postRun === 'function') Module.postRun = [Module.postRun]
    while (Module.postRun.length) {
      addOnPostRun(Module.postRun.shift())
    }
  }

  callRuntimeCallbacks(__ATPOSTRUN__)
}

function addOnPreRun (cb) {
  __ATPRERUN__.unshift(cb)
}

function addOnInit (cb) {
  __ATINIT__.unshift(cb)
}

function addOnPreMain (cb) {
  __ATMAIN__.unshift(cb)
}

function addOnExit (cb) {
}

function addOnPostRun (cb) {
  __ATPOSTRUN__.unshift(cb)
}

function unSign (value, bits, ignore) {
  if (value >= 0) {
    return value
  }
  return bits <= 32 ? 2 * Math.abs(1 << (bits - 1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
    : Math.pow(2, bits) + value
}
function reSign (value, bits, ignore) {
  if (value <= 0) {
    return value
  }
  var half = bits <= 32 ? Math.abs(1 << (bits - 1)) // abs is needed if bits == 32
    : Math.pow(2, bits - 1)
  if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
    // but, in general there is no perfect solution here. With 64-bit ints, we get rounding and errors
    // TODO: In i64 mode 1, resign the two parts separately and safely
    value = -2 * half + value // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
  }
  return value
}

assert(Math.imul, 'This browser does not support Math.imul(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill')
assert(Math.fround, 'This browser does not support Math.fround(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill')
assert(Math.clz32, 'This browser does not support Math.clz32(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill')
assert(Math.trunc, 'This browser does not support Math.trunc(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill')

var Math_abs = Math.abs
var Math_cos = Math.cos
var Math_sin = Math.sin
var Math_tan = Math.tan
var Math_acos = Math.acos
var Math_asin = Math.asin
var Math_atan = Math.atan
var Math_atan2 = Math.atan2
var Math_exp = Math.exp
var Math_log = Math.log
var Math_sqrt = Math.sqrt
var Math_ceil = Math.ceil
var Math_floor = Math.floor
var Math_pow = Math.pow
var Math_imul = Math.imul
var Math_fround = Math.fround
var Math_round = Math.round
var Math_min = Math.min
var Math_max = Math.max
var Math_clz32 = Math.clz32
var Math_trunc = Math.trunc

// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0
var runDependencyWatcher = null
var dependenciesFulfilled = null // overridden to take different actions when all run dependencies are fulfilled
var runDependencyTracking = {}

function getUniqueRunDependency (id) {
  var orig = id
  while (1) {
    if (!runDependencyTracking[id]) return id
    id = orig + Math.random()
  }
  return id
}

function addRunDependency (id) {
  runDependencies++

  if (Module.monitorRunDependencies) {
    Module.monitorRunDependencies(runDependencies)
  }

  if (id) {
    assert(!runDependencyTracking[id])
    runDependencyTracking[id] = 1
    if (runDependencyWatcher === null && typeof setInterval !== 'undefined') {
      // Check for missing dependencies every few seconds
      runDependencyWatcher = setInterval(function () {
        if (ABORT) {
          clearInterval(runDependencyWatcher)
          runDependencyWatcher = null
          return
        }
        var shown = false
        for (var dep in runDependencyTracking) {
          if (!shown) {
            shown = true
            err('still waiting on run dependencies:')
          }
          err('dependency: ' + dep)
        }
        if (shown) {
          err('(end of list)')
        }
      }, 10000)
    }
  } else {
    err('warning: run dependency added without ID')
  }
}

function removeRunDependency (id) {
  runDependencies--

  if (Module.monitorRunDependencies) {
    Module.monitorRunDependencies(runDependencies)
  }

  if (id) {
    assert(runDependencyTracking[id])
    delete runDependencyTracking[id]
  } else {
    err('warning: run dependency removed without ID')
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher)
      runDependencyWatcher = null
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled
      dependenciesFulfilled = null
      callback() // can add another dependenciesFulfilled
    }
  }
}

Module.preloadedImages = {} // maps url to image data
Module.preloadedAudios = {} // maps url to audio data

function abort (what) {
  if (Module.onAbort) {
    Module.onAbort(what)
  }

  what += ''
  out(what)
  err(what)

  ABORT = true
  EXITSTATUS = 1

  var output = 'abort(' + what + ') at ' + stackTrace()
  what = output

  // Throw a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  throw what
}

var memoryInitializer = null

// show errors on likely calls to FS when it was not included
var FS = {
  error: function () {
    abort('Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with  -s FORCE_FILESYSTEM=1')
  },
  init: function () { FS.error() },
  createDataFile: function () { FS.error() },
  createPreloadedFile: function () { FS.error() },
  createLazyFile: function () { FS.error() },
  open: function () { FS.error() },
  mkdev: function () { FS.error() },
  registerDevice: function () { FS.error() },
  analyzePath: function () { FS.error() },
  loadFilesFromDB: function () { FS.error() },

  ErrnoError: function ErrnoError () { FS.error() }
}
Module.FS_createDataFile = FS.createDataFile
Module.FS_createPreloadedFile = FS.createPreloadedFile

// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,'

// Indicates whether filename is a base64 data URI.
function isDataURI (filename) {
  return String.prototype.startsWith
    ? filename.startsWith(dataURIPrefix)
    : filename.indexOf(dataURIPrefix) === 0
}

// Globals used by JS i64 conversions
var tempDouble
var tempI64

// === Body ===

var ASM_CONSTS = []

// STATICTOP = STATIC_BASE + 1928;
/* global initializers */ /* __ATINIT__.push(); */

memoryInitializer = 'example.out.asm.js.mem'

/* no memory initializer */
var tempDoublePtr = 1920
assert(tempDoublePtr % 8 == 0)

function copyTempFloat (ptr) { // functions, because inlining this code increases code size too much
  HEAP8[tempDoublePtr] = HEAP8[ptr]
  HEAP8[tempDoublePtr + 1] = HEAP8[ptr + 1]
  HEAP8[tempDoublePtr + 2] = HEAP8[ptr + 2]
  HEAP8[tempDoublePtr + 3] = HEAP8[ptr + 3]
}

function copyTempDouble (ptr) {
  HEAP8[tempDoublePtr] = HEAP8[ptr]
  HEAP8[tempDoublePtr + 1] = HEAP8[ptr + 1]
  HEAP8[tempDoublePtr + 2] = HEAP8[ptr + 2]
  HEAP8[tempDoublePtr + 3] = HEAP8[ptr + 3]
  HEAP8[tempDoublePtr + 4] = HEAP8[ptr + 4]
  HEAP8[tempDoublePtr + 5] = HEAP8[ptr + 5]
  HEAP8[tempDoublePtr + 6] = HEAP8[ptr + 6]
  HEAP8[tempDoublePtr + 7] = HEAP8[ptr + 7]
}

// {{PRE_LIBRARY}}

function demangle (func) {
  warnOnce('warning: build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling')
  return func
}

function demangleAll (text) {
  var regex =
        /\b__Z[\w\d_]+/g
  return text.replace(regex,
    function (x) {
      var y = demangle(x)
      return x === y ? x : (y + ' [' + x + ']')
    })
}

function jsStackTrace () {
  var err = new Error()
  if (!err.stack) {
    // IE10+ special cases: It does have callstack info, but it is only populated if an Error object is thrown,
    // so try that as a special-case.
    try {
      throw new Error(0)
    } catch (e) {
      err = e
    }
    if (!err.stack) {
      return '(no stack trace available)'
    }
  }
  return err.stack.toString()
}

function stackTrace () {
  var js = jsStackTrace()
  if (Module.extraStackTrace) js += '\n' + Module.extraStackTrace()
  return demangleAll(js)
}

function ___lock () {}

function ___unlock () {}

function flush_NO_FILESYSTEM () {
  // flush anything remaining in the buffers during shutdown
  var fflush = Module._fflush
  if (fflush) fflush(0)
  var buffers = SYSCALLS.buffers
  if (buffers[1].length) SYSCALLS.printChar(1, 10)
  if (buffers[2].length) SYSCALLS.printChar(2, 10)
}

var PATH = {
  splitPath: function (filename) {
    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/
    return splitPathRe.exec(filename).slice(1)
  },
  normalizeArray: function (parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
    var up = 0
    for (var i = parts.length - 1; i >= 0; i--) {
      var last = parts[i]
      if (last === '.') {
        parts.splice(i, 1)
      } else if (last === '..') {
        parts.splice(i, 1)
        up++
      } else if (up) {
        parts.splice(i, 1)
        up--
      }
    }
    // if the path is allowed to go above the root, restore leading ..s
    if (allowAboveRoot) {
      for (; up; up--) {
        parts.unshift('..')
      }
    }
    return parts
  },
  normalize: function (path) {
    var isAbsolute = path.charAt(0) === '/'
    var trailingSlash = path.substr(-1) === '/'
    // Normalize the path
    path = PATH.normalizeArray(path.split('/').filter(function (p) {
      return !!p
    }), !isAbsolute).join('/')
    if (!path && !isAbsolute) {
      path = '.'
    }
    if (path && trailingSlash) {
      path += '/'
    }
    return (isAbsolute ? '/' : '') + path
  },
  dirname: function (path) {
    var result = PATH.splitPath(path)
    var root = result[0]
    var dir = result[1]
    if (!root && !dir) {
    // No dirname whatsoever
      return '.'
    }
    if (dir) {
    // It has a dirname, strip trailing slash
      dir = dir.substr(0, dir.length - 1)
    }
    return root + dir
  },
  basename: function (path) {
  // EMSCRIPTEN return '/'' for '/', not an empty string
    if (path === '/') return '/'
    var lastSlash = path.lastIndexOf('/')
    if (lastSlash === -1) return path
    return path.substr(lastSlash + 1)
  },
  extname: function (path) {
    return PATH.splitPath(path)[3]
  },
  join: function () {
    var paths = Array.prototype.slice.call(arguments, 0)
    return PATH.normalize(paths.join('/'))
  },
  join2: function (l, r) {
    return PATH.normalize(l + '/' + r)
  }
}; var SYSCALLS = {
  buffers: [null, [], []],
  printChar: function (stream, curr) {
    var buffer = SYSCALLS.buffers[stream]
    assert(buffer)
    if (curr === 0 || curr === 10) {
      (stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0))
      buffer.length = 0
    } else {
      buffer.push(curr)
    }
  },
  varargs: 0,
  get: function (varargs) {
    SYSCALLS.varargs += 4
    var ret = HEAP32[(((SYSCALLS.varargs) - (4)) >> 2)]
    return ret
  },
  getStr: function () {
    var ret = UTF8ToString(SYSCALLS.get())
    return ret
  },
  get64: function () {
    var low = SYSCALLS.get(); var high = SYSCALLS.get()
    if (low >= 0) assert(high === 0)
    else assert(high === -1)
    return low
  },
  getZero: function () {
    assert(SYSCALLS.get() === 0)
  }
}; function _fd_write (fd, iov, iovcnt, pnum) {
  try {
  // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
    var num = 0
    for (var i = 0; i < iovcnt; i++) {
      var ptr = HEAP32[(((iov) + (i * 8)) >> 2)]
      var len = HEAP32[(((iov) + (i * 8 + 4)) >> 2)]
      for (var j = 0; j < len; j++) {
        SYSCALLS.printChar(fd, HEAPU8[ptr + j])
      }
      num += len
    }
    HEAP32[((pnum) >> 2)] = num
    return 0
  } catch (e) {
    if (typeof FS === 'undefined' || !(e instanceof FS.ErrnoError)) abort(e)
    return e.errno
  }
} function ___wasi_fd_write () {
  return _fd_write.apply(null, arguments)
}

function _emscripten_get_heap_size () {
  return HEAP8.length
}

function abortOnCannotGrowMemory (requestedSize) {
  abort('Cannot enlarge memory arrays to size ' + requestedSize + ' bytes (OOM). Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value ' + HEAP8.length + ', (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime but prevents some optimizations, (3) set Module.TOTAL_MEMORY to a higher value before the program runs, or (4) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ')
}

function emscripten_realloc_buffer (size) {
  try {
    var newBuffer = new ArrayBuffer(size)
    if (newBuffer.byteLength != size) return /* undefined, allocation did not succeed */
    new Int8Array(newBuffer).set(HEAP8)
    _emscripten_replace_memory(newBuffer)
    updateGlobalBufferAndViews(newBuffer)
    return 1 /* success */
  } catch (e) {
    console.error('emscripten_realloc_buffer: Attempted to grow heap from ' + buffer.byteLength + ' bytes to ' + size + ' bytes, but got error: ' + e)
  }
} function _emscripten_resize_heap (requestedSize) {
  var oldSize = _emscripten_get_heap_size()
  // With pthreads, races can happen (another thread might increase the size in between), so return a failure, and let the caller retry.
  assert(requestedSize > oldSize)

  var PAGE_MULTIPLE = 16777216
  var LIMIT = 2147483648 - PAGE_MULTIPLE // We can do one page short of 2GB as theoretical maximum.

  if (requestedSize > LIMIT) {
    err('Cannot enlarge memory, asked to go up to ' + requestedSize + ' bytes, but the limit is ' + LIMIT + ' bytes!')
    return false
  }

  var MIN_TOTAL_MEMORY = 16777216
  var newSize = Math.max(oldSize, MIN_TOTAL_MEMORY) // So the loop below will not be infinite, and minimum asm.js memory size is 16MB.

  // TODO: see realloc_buffer - for PTHREADS we may want to decrease these jumps
  while (newSize < requestedSize) { // Keep incrementing the heap size as long as it's less than what is requested.
    if (newSize <= 536870912) {
      newSize = alignUp(2 * newSize, PAGE_MULTIPLE) // Simple heuristic: double until 1GB...
    } else {
      // ..., but after that, add smaller increments towards 2GB, which we cannot reach
      newSize = Math.min(alignUp((3 * newSize + 2147483648) / 4, PAGE_MULTIPLE), LIMIT)
    }

    if (newSize === oldSize) {
      warnOnce('Cannot ask for more memory since we reached the practical limit in browsers (which is just below 2GB), so the request would have failed. Requesting only ' + HEAP8.length)
    }
  }

  var replacement = emscripten_realloc_buffer(newSize)
  if (!replacement) {
    err('Failed to grow the heap from ' + oldSize + ' bytes to ' + newSize + ' bytes, not enough memory!')
    return false
  }

  err('Warning: Enlarging memory arrays, this is not fast! ' + [oldSize, newSize])

  return true
}

function _emscripten_memcpy_big (dest, src, num) {
  HEAPU8.set(HEAPU8.subarray(src, src + num), dest)
}

var ASSERTIONS = true

// Copyright 2017 The Emscripten Authors.  All rights reserved.
// Emscripten is available under two separate licenses, the MIT license and the
// University of Illinois/NCSA Open Source License.  Both these licenses can be
// found in the LICENSE file.

/** @type {function(string, boolean=, number=)} */
function intArrayFromString (stringy, dontAddNull, length) {
  var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1
  var u8array = new Array(len)
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length)
  if (dontAddNull) u8array.length = numBytesWritten
  return u8array
}

function intArrayToString (array) {
  var ret = []
  for (var i = 0; i < array.length; i++) {
    var chr = array[i]
    if (chr > 0xFF) {
      if (ASSERTIONS) {
        assert(false, 'Character code ' + chr + ' (' + String.fromCharCode(chr) + ')  at offset ' + i + ' not in 0x00-0xFF.')
      }
      chr &= 0xFF
    }
    ret.push(String.fromCharCode(chr))
  }
  return ret.join('')
}

// ASM_LIBRARY EXTERN PRIMITIVES: Int8Array,Int32Array

function nullFunc_ii (x) { abortFnPtrError(x, 'ii') }
function nullFunc_iiii (x) { abortFnPtrError(x, 'iiii') }
function nullFunc_iiiii (x) { abortFnPtrError(x, 'iiiii') }

var asmGlobalArg = { Int8Array: Int8Array, Int32Array: Int32Array }

var asmLibraryArg = { ___lock: ___lock, ___unlock: ___unlock, ___wasi_fd_write: ___wasi_fd_write, _emscripten_get_heap_size: _emscripten_get_heap_size, _emscripten_memcpy_big: _emscripten_memcpy_big, _emscripten_resize_heap: _emscripten_resize_heap, _fd_write: _fd_write, abort: abort, abortOnCannotGrowMemory: abortOnCannotGrowMemory, abortStackOverflow: abortStackOverflow, demangle: demangle, demangleAll: demangleAll, emscripten_realloc_buffer: emscripten_realloc_buffer, flush_NO_FILESYSTEM: flush_NO_FILESYSTEM, getTempRet0: getTempRet0, jsStackTrace: jsStackTrace, nullFunc_ii: nullFunc_ii, nullFunc_iiii: nullFunc_iiii, nullFunc_iiiii: nullFunc_iiiii, setTempRet0: setTempRet0, stackTrace: stackTrace, tempDoublePtr: tempDoublePtr }
// EMSCRIPTEN_START_ASM
var asm = (/** @suppress {uselessCode} */ function (global, env, buffer) {
  'almost asm'

  var HEAP8 = new global.Int8Array(buffer)
  var HEAP32 = new global.Int32Array(buffer)
  var tempDoublePtr = env.tempDoublePtr | 0
  var __THREW__ = 0
  var threwValue = 0
  var setjmpId = 0
  var tempInt = 0
  var tempBigInt = 0
  var tempBigIntS = 0
  var tempValue = 0
  var tempDouble = 0.0
  var abort = env.abort
  var setTempRet0 = env.setTempRet0
  var getTempRet0 = env.getTempRet0
  var abortStackOverflow = env.abortStackOverflow
  var nullFunc_ii = env.nullFunc_ii
  var nullFunc_iiii = env.nullFunc_iiii
  var nullFunc_iiiii = env.nullFunc_iiiii
  var ___lock = env.___lock
  var ___unlock = env.___unlock
  var ___wasi_fd_write = env.___wasi_fd_write
  var _emscripten_get_heap_size = env._emscripten_get_heap_size
  var _emscripten_memcpy_big = env._emscripten_memcpy_big
  var _emscripten_resize_heap = env._emscripten_resize_heap
  var _fd_write = env._fd_write
  var abortOnCannotGrowMemory = env.abortOnCannotGrowMemory
  var demangle = env.demangle
  var demangleAll = env.demangleAll
  var emscripten_realloc_buffer = env.emscripten_realloc_buffer
  var flush_NO_FILESYSTEM = env.flush_NO_FILESYSTEM
  var jsStackTrace = env.jsStackTrace
  var stackTrace = env.stackTrace
  var STACKTOP = 1936
  var STACK_MAX = 5244816
  var tempFloat = 0.0

  function _emscripten_replace_memory (newBuffer) {
    HEAP8 = new Int8Array(newBuffer)
    HEAP32 = new Int32Array(newBuffer)

    buffer = newBuffer
    return true
  }

  // EMSCRIPTEN_START_FUNCS

  function stackAlloc (size) {
    size = size | 0
    var ret = 0
    ret = STACKTOP
    STACKTOP = (STACKTOP + size) | 0
    STACKTOP = (STACKTOP + 15) & -16
    if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(size | 0)

    return ret | 0
  }
  function stackSave () {
    return STACKTOP | 0
  }
  function stackRestore (top) {
    top = top | 0
    STACKTOP = top
  }
  function establishStackSpace (stackBase, stackMax) {
    stackBase = stackBase | 0
    stackMax = stackMax | 0
    STACKTOP = stackBase
    STACK_MAX = stackMax
  }

  function _benchMarkAdd ($0, $1) {
    $0 = $0 | 0
    $1 = $1 | 0
    var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $2 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 16 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(16 | 0)
    $2 = $0
    $3 = $1
    $5 = 0
    while (1) {
      $6 = $5
      $7 = ($6 | 0) < (10000000)
      if (!($7)) {
        break
      }
      $8 = $2
      $9 = $3
      $10 = (($8) + ($9)) | 0
      $4 = $10
      $11 = $5
      $12 = (($11) + 1) | 0
      $5 = $12
    }
    $13 = $4
    STACKTOP = sp; return ($13 | 0)
  }
  function _addInt ($0, $1) {
    $0 = $0 | 0
    $1 = $1 | 0
    var $2 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 16 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(16 | 0)
    $2 = $0
    $3 = $1
    $4 = $2
    $5 = $3
    $6 = (($4) + ($5)) | 0
    STACKTOP = sp; return ($6 | 0)
  }
  function _sumInt ($0, $1) {
    $0 = $0 | 0
    $1 = $1 | 0
    var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $14 = 0; var $15 = 0; var $16 = 0; var $17 = 0; var $2 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 16 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(16 | 0)
    $2 = $0
    $3 = $1
    $4 = 0
    $5 = 0
    while (1) {
      $6 = $5
      $7 = $3
      $8 = ($6 | 0) < ($7 | 0)
      if (!($8)) {
        break
      }
      $9 = $2
      $10 = $5
      $11 = (($9) + ($10 << 2) | 0)
      $12 = HEAP32[$11 >> 2] | 0
      $13 = $4
      $14 = (($13) + ($12)) | 0
      $4 = $14
      $15 = $5
      $16 = (($15) + 1) | 0
      $5 = $16
    }
    $17 = $4
    STACKTOP = sp; return ($17 | 0)
  }
  function _doubleIntArray ($0, $1, $2) {
    $0 = $0 | 0
    $1 = $1 | 0
    $2 = $2 | 0
    var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $14 = 0; var $15 = 0; var $16 = 0; var $17 = 0; var $18 = 0; var $19 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 16 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(16 | 0)
    $3 = $0
    $4 = $1
    $5 = $2
    $6 = 0
    while (1) {
      $7 = $6
      $8 = $5
      $9 = ($7 | 0) < ($8 | 0)
      if (!($9)) {
        break
      }
      $10 = $3
      $11 = $6
      $12 = (($10) + ($11 << 2) | 0)
      $13 = HEAP32[$12 >> 2] | 0
      $14 = $13 << 1
      $15 = $4
      $16 = $6
      $17 = (($15) + ($16 << 2) | 0)
      HEAP32[$17 >> 2] = $14
      $18 = $6
      $19 = (($18) + 1) | 0
      $6 = $19
    }
    STACKTOP = sp
  }
  function ___stdio_write ($0, $1, $2) {
    $0 = $0 | 0
    $1 = $1 | 0
    $2 = $2 | 0
    var $$048 = 0; var $$049 = 0; var $$050 = 0; var $$052 = 0; var $$1 = 0; var $$153 = 0; var $$156$ph = 0; var $$pr = 0; var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $14 = 0; var $15 = 0; var $16 = 0; var $17 = 0; var $18 = 0; var $19 = 0; var $20 = 0; var $21 = 0
    var $22 = 0; var $23 = 0; var $24 = 0; var $25 = 0; var $26 = 0; var $27 = 0; var $28 = 0; var $29 = 0; var $3 = 0; var $30 = 0; var $31 = 0; var $32 = 0; var $33 = 0; var $34 = 0; var $35 = 0; var $36 = 0; var $37 = 0; var $38 = 0; var $39 = 0; var $4 = 0
    var $40 = 0; var $41 = 0; var $42 = 0; var $43 = 0; var $44 = 0; var $45 = 0; var $46 = 0; var $47 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 32 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(32 | 0)
    $3 = sp
    $4 = sp + 16 | 0
    $5 = ((($0)) + 28 | 0)
    $6 = HEAP32[$5 >> 2] | 0
    HEAP32[$3 >> 2] = $6
    $7 = ((($3)) + 4 | 0)
    $8 = ((($0)) + 20 | 0)
    $9 = HEAP32[$8 >> 2] | 0
    $10 = (($9) - ($6)) | 0
    HEAP32[$7 >> 2] = $10
    $11 = ((($3)) + 8 | 0)
    HEAP32[$11 >> 2] = $1
    $12 = ((($3)) + 12 | 0)
    HEAP32[$12 >> 2] = $2
    $13 = (($10) + ($2)) | 0
    $14 = ((($0)) + 60 | 0)
    $$049 = 2; $$050 = $13; $$052 = $3
    while (1) {
      $15 = HEAP32[$14 >> 2] | 0
      $16 = (___wasi_fd_write(($15 | 0), ($$052 | 0), ($$049 | 0), ($4 | 0)) | 0)
      $17 = (___wasi_syscall_ret($16) | 0)
      $18 = ($17 | 0) == (0)
      if ($18) {
        $$pr = HEAP32[$4 >> 2] | 0
        $20 = $$pr
      } else {
        HEAP32[$4 >> 2] = -1
        $20 = -1
      }
      $19 = ($$050 | 0) == ($20 | 0)
      if ($19) {
        label = 6
        break
      }
      $28 = ($20 | 0) < (0)
      if ($28) {
        label = 8
        break
      }
      $36 = (($$050) - ($20)) | 0
      $37 = ((($$052)) + 4 | 0)
      $38 = HEAP32[$37 >> 2] | 0
      $39 = ($20 >>> 0) > ($38 >>> 0)
      $40 = ((($$052)) + 8 | 0)
      $$153 = $39 ? $40 : $$052
      $41 = $39 << 31 >> 31
      $$1 = (($$049) + ($41)) | 0
      $42 = $39 ? $38 : 0
      $$048 = (($20) - ($42)) | 0
      $43 = HEAP32[$$153 >> 2] | 0
      $44 = (($43) + ($$048) | 0)
      HEAP32[$$153 >> 2] = $44
      $45 = ((($$153)) + 4 | 0)
      $46 = HEAP32[$45 >> 2] | 0
      $47 = (($46) - ($$048)) | 0
      HEAP32[$45 >> 2] = $47
      $$049 = $$1; $$050 = $36; $$052 = $$153
    }
    if ((label | 0) == 6) {
      $21 = ((($0)) + 44 | 0)
      $22 = HEAP32[$21 >> 2] | 0
      $23 = ((($0)) + 48 | 0)
      $24 = HEAP32[$23 >> 2] | 0
      $25 = (($22) + ($24) | 0)
      $26 = ((($0)) + 16 | 0)
      HEAP32[$26 >> 2] = $25
      $27 = $22
      HEAP32[$5 >> 2] = $27
      HEAP32[$8 >> 2] = $27
      $$156$ph = $2
    } else if ((label | 0) == 8) {
      $29 = ((($0)) + 16 | 0)
      HEAP32[$29 >> 2] = 0
      HEAP32[$5 >> 2] = 0
      HEAP32[$8 >> 2] = 0
      $30 = HEAP32[$0 >> 2] | 0
      $31 = $30 | 32
      HEAP32[$0 >> 2] = $31
      $32 = ($$049 | 0) == (2)
      if ($32) {
        $$156$ph = 0
      } else {
        $33 = ((($$052)) + 4 | 0)
        $34 = HEAP32[$33 >> 2] | 0
        $35 = (($2) - ($34)) | 0
        $$156$ph = $35
      }
    }
    STACKTOP = sp; return ($$156$ph | 0)
  }
  function ___wasi_syscall_ret ($0) {
    $0 = $0 | 0
    var $$0 = 0; var $1 = 0; var $2 = 0; var $3 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    $1 = ($0 << 16 >> 16) == (0)
    if ($1) {
      $$0 = 0
    } else {
      $2 = $0 & 65535
      $3 = (___errno_location() | 0)
      HEAP32[$3 >> 2] = $2
      $$0 = -1
    }
    return ($$0 | 0)
  }
  function ___errno_location () {
    var label = 0; var sp = 0
    sp = STACKTOP
    return (1216 | 0)
  }
  function ___emscripten_stdout_close ($0) {
    $0 = $0 | 0
    var label = 0; var sp = 0
    sp = STACKTOP
    return 0
  }
  function ___emscripten_stdout_seek ($0, $1, $2, $3) {
    $0 = $0 | 0
    $1 = $1 | 0
    $2 = $2 | 0
    $3 = $3 | 0
    var label = 0; var sp = 0
    sp = STACKTOP
    setTempRet0((0) | 0)
    return 0
  }
  function ___lockfile ($0) {
    $0 = $0 | 0
    var label = 0; var sp = 0
    sp = STACKTOP
    return 1
  }
  function ___unlockfile ($0) {
    $0 = $0 | 0
    var label = 0; var sp = 0
    sp = STACKTOP
  }
  function ___ofl_lock () {
    var label = 0; var sp = 0
    sp = STACKTOP
    ___lock((1220 | 0))
    return (1228 | 0)
  }
  function ___ofl_unlock () {
    var label = 0; var sp = 0
    sp = STACKTOP
    ___unlock((1220 | 0))
  }
  function _fflush ($0) {
    $0 = $0 | 0
    var $$0 = 0; var $$023 = 0; var $$02325 = 0; var $$02327 = 0; var $$024$lcssa = 0; var $$02426 = 0; var $$1 = 0; var $1 = 0; var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $14 = 0; var $15 = 0; var $16 = 0; var $17 = 0; var $18 = 0; var $19 = 0; var $2 = 0; var $20 = 0
    var $21 = 0; var $22 = 0; var $23 = 0; var $24 = 0; var $25 = 0; var $26 = 0; var $27 = 0; var $28 = 0; var $29 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var $phitmp = 0; var label = 0; var sp = 0
    sp = STACKTOP
    $1 = ($0 | 0) == (0 | 0)
    do {
      if ($1) {
        $8 = HEAP32[40] | 0
        $9 = ($8 | 0) == (0 | 0)
        if ($9) {
          $29 = 0
        } else {
          $10 = HEAP32[40] | 0
          $11 = (_fflush($10) | 0)
          $29 = $11
        }
        $12 = (___ofl_lock() | 0)
        $$02325 = HEAP32[$12 >> 2] | 0
        $13 = ($$02325 | 0) == (0 | 0)
        if ($13) {
          $$024$lcssa = $29
        } else {
          $$02327 = $$02325; $$02426 = $29
          while (1) {
            $14 = ((($$02327)) + 76 | 0)
            $15 = HEAP32[$14 >> 2] | 0
            $16 = ($15 | 0) > (-1)
            if ($16) {
              $17 = (___lockfile($$02327) | 0)
              $26 = $17
            } else {
              $26 = 0
            }
            $18 = ((($$02327)) + 20 | 0)
            $19 = HEAP32[$18 >> 2] | 0
            $20 = ((($$02327)) + 28 | 0)
            $21 = HEAP32[$20 >> 2] | 0
            $22 = ($19 >>> 0) > ($21 >>> 0)
            if ($22) {
              $23 = (___fflush_unlocked($$02327) | 0)
              $24 = $23 | $$02426
              $$1 = $24
            } else {
              $$1 = $$02426
            }
            $25 = ($26 | 0) == (0)
            if (!($25)) {
              ___unlockfile($$02327)
            }
            $27 = ((($$02327)) + 56 | 0)
            $$023 = HEAP32[$27 >> 2] | 0
            $28 = ($$023 | 0) == (0 | 0)
            if ($28) {
              $$024$lcssa = $$1
              break
            } else {
              $$02327 = $$023; $$02426 = $$1
            }
          }
        }
        ___ofl_unlock()
        $$0 = $$024$lcssa
      } else {
        $2 = ((($0)) + 76 | 0)
        $3 = HEAP32[$2 >> 2] | 0
        $4 = ($3 | 0) > (-1)
        if (!($4)) {
          $5 = (___fflush_unlocked($0) | 0)
          $$0 = $5
          break
        }
        $6 = (___lockfile($0) | 0)
        $phitmp = ($6 | 0) == (0)
        $7 = (___fflush_unlocked($0) | 0)
        if ($phitmp) {
          $$0 = $7
        } else {
          ___unlockfile($0)
          $$0 = $7
        }
      }
    } while (0)
    return ($$0 | 0)
  }
  function ___fflush_unlocked ($0) {
    $0 = $0 | 0
    var $$0 = 0; var $1 = 0; var $10 = 0; var $11 = 0; var $12 = 0; var $13 = 0; var $14 = 0; var $15 = 0; var $16 = 0; var $17 = 0; var $18 = 0; var $19 = 0; var $2 = 0; var $20 = 0; var $21 = 0; var $22 = 0; var $23 = 0; var $3 = 0; var $4 = 0; var $5 = 0
    var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    $1 = ((($0)) + 20 | 0)
    $2 = HEAP32[$1 >> 2] | 0
    $3 = ((($0)) + 28 | 0)
    $4 = HEAP32[$3 >> 2] | 0
    $5 = ($2 >>> 0) > ($4 >>> 0)
    if ($5) {
      $6 = ((($0)) + 36 | 0)
      $7 = HEAP32[$6 >> 2] | 0;
      (FUNCTION_TABLE_iiii[$7 & 3]($0, 0, 0) | 0)
      $8 = HEAP32[$1 >> 2] | 0
      $9 = ($8 | 0) == (0 | 0)
      if ($9) {
        $$0 = -1
      } else {
        label = 3
      }
    } else {
      label = 3
    }
    if ((label | 0) == 3) {
      $10 = ((($0)) + 4 | 0)
      $11 = HEAP32[$10 >> 2] | 0
      $12 = ((($0)) + 8 | 0)
      $13 = HEAP32[$12 >> 2] | 0
      $14 = ($11 >>> 0) < ($13 >>> 0)
      if ($14) {
        $15 = $11
        $16 = $13
        $17 = (($15) - ($16)) | 0
        $18 = ($17 | 0) < (0)
        $19 = $18 << 31 >> 31
        $20 = ((($0)) + 40 | 0)
        $21 = HEAP32[$20 >> 2] | 0;
        (FUNCTION_TABLE_iiiii[$21 & 3]($0, $17, $19, 1) | 0)
        $22 = (getTempRet0() | 0)
      }
      $23 = ((($0)) + 16 | 0)
      HEAP32[$23 >> 2] = 0
      HEAP32[$3 >> 2] = 0
      HEAP32[$1 >> 2] = 0
      HEAP32[$12 >> 2] = 0
      HEAP32[$10 >> 2] = 0
      $$0 = 0
    }
    return ($$0 | 0)
  }
  function _malloc ($0) {
    $0 = $0 | 0
    var $$0 = 0; var $$0$i = 0; var $$0$i$i = 0; var $$0$i$i$i = 0; var $$0$i20$i = 0; var $$0169$i = 0; var $$0170$i = 0; var $$0171$i = 0; var $$0192 = 0; var $$0194 = 0; var $$02014$i$i = 0; var $$0202$lcssa$i$i = 0; var $$02023$i$i = 0; var $$0206$i$i = 0; var $$0207$i$i = 0; var $$024372$i = 0; var $$0259$i$i = 0; var $$02604$i$i = 0; var $$0261$lcssa$i$i = 0; var $$02613$i$i = 0
    var $$0267$i$i = 0; var $$0268$i$i = 0; var $$0318$i = 0; var $$032012$i = 0; var $$0321$lcssa$i = 0; var $$032111$i = 0; var $$0323$i = 0; var $$0329$i = 0; var $$0335$i = 0; var $$0336$i = 0; var $$0338$i = 0; var $$0339$i = 0; var $$0344$i = 0; var $$1174$i = 0; var $$1174$i$be = 0; var $$1174$i$ph = 0; var $$1176$i = 0; var $$1176$i$be = 0; var $$1176$i$ph = 0; var $$124471$i = 0
    var $$1263$i$i = 0; var $$1263$i$i$be = 0; var $$1263$i$i$ph = 0; var $$1265$i$i = 0; var $$1265$i$i$be = 0; var $$1265$i$i$ph = 0; var $$1319$i = 0; var $$1324$i = 0; var $$1340$i = 0; var $$1346$i = 0; var $$1346$i$be = 0; var $$1346$i$ph = 0; var $$1350$i = 0; var $$1350$i$be = 0; var $$1350$i$ph = 0; var $$2234243136$i = 0; var $$2247$ph$i = 0; var $$2253$ph$i = 0; var $$2331$i = 0; var $$3$i = 0
    var $$3$i$i = 0; var $$3$i198 = 0; var $$3$i198211 = 0; var $$3326$i = 0; var $$3348$i = 0; var $$4$lcssa$i = 0; var $$415$i = 0; var $$415$i$ph = 0; var $$4236$i = 0; var $$4327$lcssa$i = 0; var $$432714$i = 0; var $$432714$i$ph = 0; var $$4333$i = 0; var $$533413$i = 0; var $$533413$i$ph = 0; var $$723947$i = 0; var $$748$i = 0; var $$pre = 0; var $$pre$i = 0; var $$pre$i$i = 0
    var $$pre$i16$i = 0; var $$pre$i195 = 0; var $$pre$i204 = 0; var $$pre$phi$i$iZ2D = 0; var $$pre$phi$i17$iZ2D = 0; var $$pre$phi$i205Z2D = 0; var $$pre$phi$iZ2D = 0; var $$pre$phiZ2D = 0; var $$sink = 0; var $$sink320 = 0; var $$sink321 = 0; var $1 = 0; var $10 = 0; var $100 = 0; var $101 = 0; var $102 = 0; var $103 = 0; var $104 = 0; var $105 = 0; var $106 = 0
    var $107 = 0; var $108 = 0; var $109 = 0; var $11 = 0; var $110 = 0; var $111 = 0; var $112 = 0; var $113 = 0; var $114 = 0; var $115 = 0; var $116 = 0; var $117 = 0; var $118 = 0; var $119 = 0; var $12 = 0; var $120 = 0; var $121 = 0; var $122 = 0; var $123 = 0; var $124 = 0
    var $125 = 0; var $126 = 0; var $127 = 0; var $128 = 0; var $129 = 0; var $13 = 0; var $130 = 0; var $131 = 0; var $132 = 0; var $133 = 0; var $134 = 0; var $135 = 0; var $136 = 0; var $137 = 0; var $138 = 0; var $139 = 0; var $14 = 0; var $140 = 0; var $141 = 0; var $142 = 0
    var $143 = 0; var $144 = 0; var $145 = 0; var $146 = 0; var $147 = 0; var $148 = 0; var $149 = 0; var $15 = 0; var $150 = 0; var $151 = 0; var $152 = 0; var $153 = 0; var $154 = 0; var $155 = 0; var $156 = 0; var $157 = 0; var $158 = 0; var $159 = 0; var $16 = 0; var $160 = 0
    var $161 = 0; var $162 = 0; var $163 = 0; var $164 = 0; var $165 = 0; var $166 = 0; var $167 = 0; var $168 = 0; var $169 = 0; var $17 = 0; var $170 = 0; var $171 = 0; var $172 = 0; var $173 = 0; var $174 = 0; var $175 = 0; var $176 = 0; var $177 = 0; var $178 = 0; var $179 = 0
    var $18 = 0; var $180 = 0; var $181 = 0; var $182 = 0; var $183 = 0; var $184 = 0; var $185 = 0; var $186 = 0; var $187 = 0; var $188 = 0; var $189 = 0; var $19 = 0; var $190 = 0; var $191 = 0; var $192 = 0; var $193 = 0; var $194 = 0; var $195 = 0; var $196 = 0; var $197 = 0
    var $198 = 0; var $199 = 0; var $2 = 0; var $20 = 0; var $200 = 0; var $201 = 0; var $202 = 0; var $203 = 0; var $204 = 0; var $205 = 0; var $206 = 0; var $207 = 0; var $208 = 0; var $209 = 0; var $21 = 0; var $210 = 0; var $211 = 0; var $212 = 0; var $213 = 0; var $214 = 0
    var $215 = 0; var $216 = 0; var $217 = 0; var $218 = 0; var $219 = 0; var $22 = 0; var $220 = 0; var $221 = 0; var $222 = 0; var $223 = 0; var $224 = 0; var $225 = 0; var $226 = 0; var $227 = 0; var $228 = 0; var $229 = 0; var $23 = 0; var $230 = 0; var $231 = 0; var $232 = 0
    var $233 = 0; var $234 = 0; var $235 = 0; var $236 = 0; var $237 = 0; var $238 = 0; var $239 = 0; var $24 = 0; var $240 = 0; var $241 = 0; var $242 = 0; var $243 = 0; var $244 = 0; var $245 = 0; var $246 = 0; var $247 = 0; var $248 = 0; var $249 = 0; var $25 = 0; var $250 = 0
    var $251 = 0; var $252 = 0; var $253 = 0; var $254 = 0; var $255 = 0; var $256 = 0; var $257 = 0; var $258 = 0; var $259 = 0; var $26 = 0; var $260 = 0; var $261 = 0; var $262 = 0; var $263 = 0; var $264 = 0; var $265 = 0; var $266 = 0; var $267 = 0; var $268 = 0; var $269 = 0
    var $27 = 0; var $270 = 0; var $271 = 0; var $272 = 0; var $273 = 0; var $274 = 0; var $275 = 0; var $276 = 0; var $277 = 0; var $278 = 0; var $279 = 0; var $28 = 0; var $280 = 0; var $281 = 0; var $282 = 0; var $283 = 0; var $284 = 0; var $285 = 0; var $286 = 0; var $287 = 0
    var $288 = 0; var $289 = 0; var $29 = 0; var $290 = 0; var $291 = 0; var $292 = 0; var $293 = 0; var $294 = 0; var $295 = 0; var $296 = 0; var $297 = 0; var $298 = 0; var $299 = 0; var $3 = 0; var $30 = 0; var $300 = 0; var $301 = 0; var $302 = 0; var $303 = 0; var $304 = 0
    var $305 = 0; var $306 = 0; var $307 = 0; var $308 = 0; var $309 = 0; var $31 = 0; var $310 = 0; var $311 = 0; var $312 = 0; var $313 = 0; var $314 = 0; var $315 = 0; var $316 = 0; var $317 = 0; var $318 = 0; var $319 = 0; var $32 = 0; var $320 = 0; var $321 = 0; var $322 = 0
    var $323 = 0; var $324 = 0; var $325 = 0; var $326 = 0; var $327 = 0; var $328 = 0; var $329 = 0; var $33 = 0; var $330 = 0; var $331 = 0; var $332 = 0; var $333 = 0; var $334 = 0; var $335 = 0; var $336 = 0; var $337 = 0; var $338 = 0; var $339 = 0; var $34 = 0; var $340 = 0
    var $341 = 0; var $342 = 0; var $343 = 0; var $344 = 0; var $345 = 0; var $346 = 0; var $347 = 0; var $348 = 0; var $349 = 0; var $35 = 0; var $350 = 0; var $351 = 0; var $352 = 0; var $353 = 0; var $354 = 0; var $355 = 0; var $356 = 0; var $357 = 0; var $358 = 0; var $359 = 0
    var $36 = 0; var $360 = 0; var $361 = 0; var $362 = 0; var $363 = 0; var $364 = 0; var $365 = 0; var $366 = 0; var $367 = 0; var $368 = 0; var $369 = 0; var $37 = 0; var $370 = 0; var $371 = 0; var $372 = 0; var $373 = 0; var $374 = 0; var $375 = 0; var $376 = 0; var $377 = 0
    var $378 = 0; var $379 = 0; var $38 = 0; var $380 = 0; var $381 = 0; var $382 = 0; var $383 = 0; var $384 = 0; var $385 = 0; var $386 = 0; var $387 = 0; var $388 = 0; var $389 = 0; var $39 = 0; var $390 = 0; var $391 = 0; var $392 = 0; var $393 = 0; var $394 = 0; var $395 = 0
    var $396 = 0; var $397 = 0; var $398 = 0; var $399 = 0; var $4 = 0; var $40 = 0; var $400 = 0; var $401 = 0; var $402 = 0; var $403 = 0; var $404 = 0; var $405 = 0; var $406 = 0; var $407 = 0; var $408 = 0; var $409 = 0; var $41 = 0; var $410 = 0; var $411 = 0; var $412 = 0
    var $413 = 0; var $414 = 0; var $415 = 0; var $416 = 0; var $417 = 0; var $418 = 0; var $419 = 0; var $42 = 0; var $420 = 0; var $421 = 0; var $422 = 0; var $423 = 0; var $424 = 0; var $425 = 0; var $426 = 0; var $427 = 0; var $428 = 0; var $429 = 0; var $43 = 0; var $430 = 0
    var $431 = 0; var $432 = 0; var $433 = 0; var $434 = 0; var $435 = 0; var $436 = 0; var $437 = 0; var $438 = 0; var $439 = 0; var $44 = 0; var $440 = 0; var $441 = 0; var $442 = 0; var $443 = 0; var $444 = 0; var $445 = 0; var $446 = 0; var $447 = 0; var $448 = 0; var $449 = 0
    var $45 = 0; var $450 = 0; var $451 = 0; var $452 = 0; var $453 = 0; var $454 = 0; var $455 = 0; var $456 = 0; var $457 = 0; var $458 = 0; var $459 = 0; var $46 = 0; var $460 = 0; var $461 = 0; var $462 = 0; var $463 = 0; var $464 = 0; var $465 = 0; var $466 = 0; var $467 = 0
    var $468 = 0; var $469 = 0; var $47 = 0; var $470 = 0; var $471 = 0; var $472 = 0; var $473 = 0; var $474 = 0; var $475 = 0; var $476 = 0; var $477 = 0; var $478 = 0; var $479 = 0; var $48 = 0; var $480 = 0; var $481 = 0; var $482 = 0; var $483 = 0; var $484 = 0; var $485 = 0
    var $486 = 0; var $487 = 0; var $488 = 0; var $489 = 0; var $49 = 0; var $490 = 0; var $491 = 0; var $492 = 0; var $493 = 0; var $494 = 0; var $495 = 0; var $496 = 0; var $497 = 0; var $498 = 0; var $499 = 0; var $5 = 0; var $50 = 0; var $500 = 0; var $501 = 0; var $502 = 0
    var $503 = 0; var $504 = 0; var $505 = 0; var $506 = 0; var $507 = 0; var $508 = 0; var $509 = 0; var $51 = 0; var $510 = 0; var $511 = 0; var $512 = 0; var $513 = 0; var $514 = 0; var $515 = 0; var $516 = 0; var $517 = 0; var $518 = 0; var $519 = 0; var $52 = 0; var $520 = 0
    var $521 = 0; var $522 = 0; var $523 = 0; var $524 = 0; var $525 = 0; var $526 = 0; var $527 = 0; var $528 = 0; var $529 = 0; var $53 = 0; var $530 = 0; var $531 = 0; var $532 = 0; var $533 = 0; var $534 = 0; var $535 = 0; var $536 = 0; var $537 = 0; var $538 = 0; var $539 = 0
    var $54 = 0; var $540 = 0; var $541 = 0; var $542 = 0; var $543 = 0; var $544 = 0; var $545 = 0; var $546 = 0; var $547 = 0; var $548 = 0; var $549 = 0; var $55 = 0; var $550 = 0; var $551 = 0; var $552 = 0; var $553 = 0; var $554 = 0; var $555 = 0; var $556 = 0; var $557 = 0
    var $558 = 0; var $559 = 0; var $56 = 0; var $560 = 0; var $561 = 0; var $562 = 0; var $563 = 0; var $564 = 0; var $565 = 0; var $566 = 0; var $567 = 0; var $568 = 0; var $569 = 0; var $57 = 0; var $570 = 0; var $571 = 0; var $572 = 0; var $573 = 0; var $574 = 0; var $575 = 0
    var $576 = 0; var $577 = 0; var $578 = 0; var $579 = 0; var $58 = 0; var $580 = 0; var $581 = 0; var $582 = 0; var $583 = 0; var $584 = 0; var $585 = 0; var $586 = 0; var $587 = 0; var $588 = 0; var $589 = 0; var $59 = 0; var $590 = 0; var $591 = 0; var $592 = 0; var $593 = 0
    var $594 = 0; var $595 = 0; var $596 = 0; var $597 = 0; var $598 = 0; var $599 = 0; var $6 = 0; var $60 = 0; var $600 = 0; var $601 = 0; var $602 = 0; var $603 = 0; var $604 = 0; var $605 = 0; var $606 = 0; var $607 = 0; var $608 = 0; var $609 = 0; var $61 = 0; var $610 = 0
    var $611 = 0; var $612 = 0; var $613 = 0; var $614 = 0; var $615 = 0; var $616 = 0; var $617 = 0; var $618 = 0; var $619 = 0; var $62 = 0; var $620 = 0; var $621 = 0; var $622 = 0; var $623 = 0; var $624 = 0; var $625 = 0; var $626 = 0; var $627 = 0; var $628 = 0; var $629 = 0
    var $63 = 0; var $630 = 0; var $631 = 0; var $632 = 0; var $633 = 0; var $634 = 0; var $635 = 0; var $636 = 0; var $637 = 0; var $638 = 0; var $639 = 0; var $64 = 0; var $640 = 0; var $641 = 0; var $642 = 0; var $643 = 0; var $644 = 0; var $645 = 0; var $646 = 0; var $647 = 0
    var $648 = 0; var $649 = 0; var $65 = 0; var $650 = 0; var $651 = 0; var $652 = 0; var $653 = 0; var $654 = 0; var $655 = 0; var $656 = 0; var $657 = 0; var $658 = 0; var $659 = 0; var $66 = 0; var $660 = 0; var $661 = 0; var $662 = 0; var $663 = 0; var $664 = 0; var $665 = 0
    var $666 = 0; var $667 = 0; var $668 = 0; var $669 = 0; var $67 = 0; var $670 = 0; var $671 = 0; var $672 = 0; var $673 = 0; var $674 = 0; var $675 = 0; var $676 = 0; var $677 = 0; var $678 = 0; var $679 = 0; var $68 = 0; var $680 = 0; var $681 = 0; var $682 = 0; var $683 = 0
    var $684 = 0; var $685 = 0; var $686 = 0; var $687 = 0; var $688 = 0; var $689 = 0; var $69 = 0; var $690 = 0; var $691 = 0; var $692 = 0; var $693 = 0; var $694 = 0; var $695 = 0; var $696 = 0; var $697 = 0; var $698 = 0; var $699 = 0; var $7 = 0; var $70 = 0; var $700 = 0
    var $701 = 0; var $702 = 0; var $703 = 0; var $704 = 0; var $705 = 0; var $706 = 0; var $707 = 0; var $708 = 0; var $709 = 0; var $71 = 0; var $710 = 0; var $711 = 0; var $712 = 0; var $713 = 0; var $714 = 0; var $715 = 0; var $716 = 0; var $717 = 0; var $718 = 0; var $719 = 0
    var $72 = 0; var $720 = 0; var $721 = 0; var $722 = 0; var $723 = 0; var $724 = 0; var $725 = 0; var $726 = 0; var $727 = 0; var $728 = 0; var $729 = 0; var $73 = 0; var $730 = 0; var $731 = 0; var $732 = 0; var $733 = 0; var $734 = 0; var $735 = 0; var $736 = 0; var $737 = 0
    var $738 = 0; var $739 = 0; var $74 = 0; var $740 = 0; var $741 = 0; var $742 = 0; var $743 = 0; var $744 = 0; var $745 = 0; var $746 = 0; var $747 = 0; var $748 = 0; var $749 = 0; var $75 = 0; var $750 = 0; var $751 = 0; var $752 = 0; var $753 = 0; var $754 = 0; var $755 = 0
    var $756 = 0; var $757 = 0; var $758 = 0; var $759 = 0; var $76 = 0; var $760 = 0; var $761 = 0; var $762 = 0; var $763 = 0; var $764 = 0; var $765 = 0; var $766 = 0; var $767 = 0; var $768 = 0; var $769 = 0; var $77 = 0; var $770 = 0; var $771 = 0; var $772 = 0; var $773 = 0
    var $774 = 0; var $775 = 0; var $776 = 0; var $777 = 0; var $778 = 0; var $779 = 0; var $78 = 0; var $780 = 0; var $781 = 0; var $782 = 0; var $783 = 0; var $784 = 0; var $785 = 0; var $786 = 0; var $787 = 0; var $788 = 0; var $789 = 0; var $79 = 0; var $790 = 0; var $791 = 0
    var $792 = 0; var $793 = 0; var $794 = 0; var $795 = 0; var $796 = 0; var $797 = 0; var $798 = 0; var $799 = 0; var $8 = 0; var $80 = 0; var $800 = 0; var $801 = 0; var $802 = 0; var $803 = 0; var $804 = 0; var $805 = 0; var $806 = 0; var $807 = 0; var $808 = 0; var $809 = 0
    var $81 = 0; var $810 = 0; var $811 = 0; var $812 = 0; var $813 = 0; var $814 = 0; var $815 = 0; var $816 = 0; var $817 = 0; var $818 = 0; var $819 = 0; var $82 = 0; var $820 = 0; var $821 = 0; var $822 = 0; var $823 = 0; var $824 = 0; var $825 = 0; var $826 = 0; var $827 = 0
    var $828 = 0; var $829 = 0; var $83 = 0; var $830 = 0; var $831 = 0; var $832 = 0; var $833 = 0; var $834 = 0; var $835 = 0; var $836 = 0; var $837 = 0; var $838 = 0; var $839 = 0; var $84 = 0; var $840 = 0; var $841 = 0; var $842 = 0; var $843 = 0; var $844 = 0; var $845 = 0
    var $846 = 0; var $847 = 0; var $848 = 0; var $849 = 0; var $85 = 0; var $850 = 0; var $851 = 0; var $852 = 0; var $853 = 0; var $854 = 0; var $855 = 0; var $856 = 0; var $857 = 0; var $858 = 0; var $859 = 0; var $86 = 0; var $860 = 0; var $861 = 0; var $862 = 0; var $863 = 0
    var $864 = 0; var $865 = 0; var $866 = 0; var $867 = 0; var $868 = 0; var $869 = 0; var $87 = 0; var $870 = 0; var $871 = 0; var $872 = 0; var $873 = 0; var $874 = 0; var $875 = 0; var $876 = 0; var $877 = 0; var $878 = 0; var $879 = 0; var $88 = 0; var $880 = 0; var $881 = 0
    var $882 = 0; var $883 = 0; var $884 = 0; var $885 = 0; var $886 = 0; var $887 = 0; var $888 = 0; var $889 = 0; var $89 = 0; var $890 = 0; var $891 = 0; var $892 = 0; var $893 = 0; var $894 = 0; var $895 = 0; var $896 = 0; var $897 = 0; var $898 = 0; var $899 = 0; var $9 = 0
    var $90 = 0; var $900 = 0; var $901 = 0; var $902 = 0; var $903 = 0; var $904 = 0; var $905 = 0; var $906 = 0; var $907 = 0; var $908 = 0; var $909 = 0; var $91 = 0; var $910 = 0; var $911 = 0; var $912 = 0; var $913 = 0; var $914 = 0; var $915 = 0; var $916 = 0; var $917 = 0
    var $918 = 0; var $919 = 0; var $92 = 0; var $920 = 0; var $921 = 0; var $922 = 0; var $923 = 0; var $924 = 0; var $925 = 0; var $926 = 0; var $927 = 0; var $928 = 0; var $929 = 0; var $93 = 0; var $930 = 0; var $931 = 0; var $932 = 0; var $933 = 0; var $934 = 0; var $935 = 0
    var $936 = 0; var $937 = 0; var $938 = 0; var $939 = 0; var $94 = 0; var $940 = 0; var $941 = 0; var $942 = 0; var $943 = 0; var $944 = 0; var $945 = 0; var $946 = 0; var $947 = 0; var $948 = 0; var $949 = 0; var $95 = 0; var $950 = 0; var $951 = 0; var $952 = 0; var $953 = 0
    var $954 = 0; var $955 = 0; var $956 = 0; var $957 = 0; var $958 = 0; var $959 = 0; var $96 = 0; var $960 = 0; var $961 = 0; var $962 = 0; var $963 = 0; var $964 = 0; var $965 = 0; var $966 = 0; var $967 = 0; var $968 = 0; var $969 = 0; var $97 = 0; var $970 = 0; var $971 = 0
    var $972 = 0; var $973 = 0; var $974 = 0; var $975 = 0; var $976 = 0; var $977 = 0; var $978 = 0; var $979 = 0; var $98 = 0; var $99 = 0; var $cond$i = 0; var $cond$i$i = 0; var $cond$i203 = 0; var $not$$i = 0; var $or$cond$i = 0; var $or$cond$i199 = 0; var $or$cond1$i = 0; var $or$cond1$i197 = 0; var $or$cond11$i = 0; var $or$cond2$i = 0
    var $or$cond5$i = 0; var $or$cond50$i = 0; var $or$cond51$i = 0; var $or$cond6$i = 0; var $or$cond7$i = 0; var $or$cond8$i = 0; var $or$cond8$not$i = 0; var $spec$select$i = 0; var $spec$select$i201 = 0; var $spec$select1$i = 0; var $spec$select2$i = 0; var $spec$select4$i = 0; var $spec$select49$i = 0; var $spec$select9$i = 0; var label = 0; var sp = 0
    sp = STACKTOP
    STACKTOP = STACKTOP + 16 | 0; if ((STACKTOP | 0) >= (STACK_MAX | 0)) abortStackOverflow(16 | 0)
    $1 = sp
    $2 = ($0 >>> 0) < (245)
    do {
      if ($2) {
        $3 = ($0 >>> 0) < (11)
        $4 = (($0) + 11) | 0
        $5 = $4 & -8
        $6 = $3 ? 16 : $5
        $7 = $6 >>> 3
        $8 = HEAP32[308] | 0
        $9 = $8 >>> $7
        $10 = $9 & 3
        $11 = ($10 | 0) == (0)
        if (!($11)) {
          $12 = $9 & 1
          $13 = $12 ^ 1
          $14 = (($13) + ($7)) | 0
          $15 = $14 << 1
          $16 = (1272 + ($15 << 2) | 0)
          $17 = ((($16)) + 8 | 0)
          $18 = HEAP32[$17 >> 2] | 0
          $19 = ((($18)) + 8 | 0)
          $20 = HEAP32[$19 >> 2] | 0
          $21 = ($20 | 0) == ($16 | 0)
          if ($21) {
            $22 = 1 << $14
            $23 = $22 ^ -1
            $24 = $8 & $23
            HEAP32[308] = $24
          } else {
            $25 = ((($20)) + 12 | 0)
            HEAP32[$25 >> 2] = $16
            HEAP32[$17 >> 2] = $20
          }
          $26 = $14 << 3
          $27 = $26 | 3
          $28 = ((($18)) + 4 | 0)
          HEAP32[$28 >> 2] = $27
          $29 = (($18) + ($26) | 0)
          $30 = ((($29)) + 4 | 0)
          $31 = HEAP32[$30 >> 2] | 0
          $32 = $31 | 1
          HEAP32[$30 >> 2] = $32
          $$0 = $19
          STACKTOP = sp; return ($$0 | 0)
        }
        $33 = HEAP32[(1240) >> 2] | 0
        $34 = ($6 >>> 0) > ($33 >>> 0)
        if ($34) {
          $35 = ($9 | 0) == (0)
          if (!($35)) {
            $36 = $9 << $7
            $37 = 2 << $7
            $38 = (0 - ($37)) | 0
            $39 = $37 | $38
            $40 = $36 & $39
            $41 = (0 - ($40)) | 0
            $42 = $40 & $41
            $43 = (($42) + -1) | 0
            $44 = $43 >>> 12
            $45 = $44 & 16
            $46 = $43 >>> $45
            $47 = $46 >>> 5
            $48 = $47 & 8
            $49 = $48 | $45
            $50 = $46 >>> $48
            $51 = $50 >>> 2
            $52 = $51 & 4
            $53 = $49 | $52
            $54 = $50 >>> $52
            $55 = $54 >>> 1
            $56 = $55 & 2
            $57 = $53 | $56
            $58 = $54 >>> $56
            $59 = $58 >>> 1
            $60 = $59 & 1
            $61 = $57 | $60
            $62 = $58 >>> $60
            $63 = (($61) + ($62)) | 0
            $64 = $63 << 1
            $65 = (1272 + ($64 << 2) | 0)
            $66 = ((($65)) + 8 | 0)
            $67 = HEAP32[$66 >> 2] | 0
            $68 = ((($67)) + 8 | 0)
            $69 = HEAP32[$68 >> 2] | 0
            $70 = ($69 | 0) == ($65 | 0)
            if ($70) {
              $71 = 1 << $63
              $72 = $71 ^ -1
              $73 = $8 & $72
              HEAP32[308] = $73
              $90 = $73
            } else {
              $74 = ((($69)) + 12 | 0)
              HEAP32[$74 >> 2] = $65
              HEAP32[$66 >> 2] = $69
              $90 = $8
            }
            $75 = $63 << 3
            $76 = (($75) - ($6)) | 0
            $77 = $6 | 3
            $78 = ((($67)) + 4 | 0)
            HEAP32[$78 >> 2] = $77
            $79 = (($67) + ($6) | 0)
            $80 = $76 | 1
            $81 = ((($79)) + 4 | 0)
            HEAP32[$81 >> 2] = $80
            $82 = (($67) + ($75) | 0)
            HEAP32[$82 >> 2] = $76
            $83 = ($33 | 0) == (0)
            if (!($83)) {
              $84 = HEAP32[(1252) >> 2] | 0
              $85 = $33 >>> 3
              $86 = $85 << 1
              $87 = (1272 + ($86 << 2) | 0)
              $88 = 1 << $85
              $89 = $90 & $88
              $91 = ($89 | 0) == (0)
              if ($91) {
                $92 = $90 | $88
                HEAP32[308] = $92
                $$pre = ((($87)) + 8 | 0)
                $$0194 = $87; $$pre$phiZ2D = $$pre
              } else {
                $93 = ((($87)) + 8 | 0)
                $94 = HEAP32[$93 >> 2] | 0
                $$0194 = $94; $$pre$phiZ2D = $93
              }
              HEAP32[$$pre$phiZ2D >> 2] = $84
              $95 = ((($$0194)) + 12 | 0)
              HEAP32[$95 >> 2] = $84
              $96 = ((($84)) + 8 | 0)
              HEAP32[$96 >> 2] = $$0194
              $97 = ((($84)) + 12 | 0)
              HEAP32[$97 >> 2] = $87
            }
            HEAP32[(1240) >> 2] = $76
            HEAP32[(1252) >> 2] = $79
            $$0 = $68
            STACKTOP = sp; return ($$0 | 0)
          }
          $98 = HEAP32[(1236) >> 2] | 0
          $99 = ($98 | 0) == (0)
          if ($99) {
            $$0192 = $6
          } else {
            $100 = (0 - ($98)) | 0
            $101 = $98 & $100
            $102 = (($101) + -1) | 0
            $103 = $102 >>> 12
            $104 = $103 & 16
            $105 = $102 >>> $104
            $106 = $105 >>> 5
            $107 = $106 & 8
            $108 = $107 | $104
            $109 = $105 >>> $107
            $110 = $109 >>> 2
            $111 = $110 & 4
            $112 = $108 | $111
            $113 = $109 >>> $111
            $114 = $113 >>> 1
            $115 = $114 & 2
            $116 = $112 | $115
            $117 = $113 >>> $115
            $118 = $117 >>> 1
            $119 = $118 & 1
            $120 = $116 | $119
            $121 = $117 >>> $119
            $122 = (($120) + ($121)) | 0
            $123 = (1536 + ($122 << 2) | 0)
            $124 = HEAP32[$123 >> 2] | 0
            $125 = ((($124)) + 4 | 0)
            $126 = HEAP32[$125 >> 2] | 0
            $127 = $126 & -8
            $128 = (($127) - ($6)) | 0
            $$0169$i = $124; $$0170$i = $124; $$0171$i = $128
            while (1) {
              $129 = ((($$0169$i)) + 16 | 0)
              $130 = HEAP32[$129 >> 2] | 0
              $131 = ($130 | 0) == (0 | 0)
              if ($131) {
                $132 = ((($$0169$i)) + 20 | 0)
                $133 = HEAP32[$132 >> 2] | 0
                $134 = ($133 | 0) == (0 | 0)
                if ($134) {
                  break
                } else {
                  $136 = $133
                }
              } else {
                $136 = $130
              }
              $135 = ((($136)) + 4 | 0)
              $137 = HEAP32[$135 >> 2] | 0
              $138 = $137 & -8
              $139 = (($138) - ($6)) | 0
              $140 = ($139 >>> 0) < ($$0171$i >>> 0)
              $spec$select$i = $140 ? $139 : $$0171$i
              $spec$select1$i = $140 ? $136 : $$0170$i
              $$0169$i = $136; $$0170$i = $spec$select1$i; $$0171$i = $spec$select$i
            }
            $141 = (($$0170$i) + ($6) | 0)
            $142 = ($141 >>> 0) > ($$0170$i >>> 0)
            if ($142) {
              $143 = ((($$0170$i)) + 24 | 0)
              $144 = HEAP32[$143 >> 2] | 0
              $145 = ((($$0170$i)) + 12 | 0)
              $146 = HEAP32[$145 >> 2] | 0
              $147 = ($146 | 0) == ($$0170$i | 0)
              do {
                if ($147) {
                  $152 = ((($$0170$i)) + 20 | 0)
                  $153 = HEAP32[$152 >> 2] | 0
                  $154 = ($153 | 0) == (0 | 0)
                  if ($154) {
                    $155 = ((($$0170$i)) + 16 | 0)
                    $156 = HEAP32[$155 >> 2] | 0
                    $157 = ($156 | 0) == (0 | 0)
                    if ($157) {
                      $$3$i = 0
                      break
                    } else {
                      $$1174$i$ph = $156; $$1176$i$ph = $155
                    }
                  } else {
                    $$1174$i$ph = $153; $$1176$i$ph = $152
                  }
                  $$1174$i = $$1174$i$ph; $$1176$i = $$1176$i$ph
                  while (1) {
                    $158 = ((($$1174$i)) + 20 | 0)
                    $159 = HEAP32[$158 >> 2] | 0
                    $160 = ($159 | 0) == (0 | 0)
                    if ($160) {
                      $161 = ((($$1174$i)) + 16 | 0)
                      $162 = HEAP32[$161 >> 2] | 0
                      $163 = ($162 | 0) == (0 | 0)
                      if ($163) {
                        break
                      } else {
                        $$1174$i$be = $162; $$1176$i$be = $161
                      }
                    } else {
                      $$1174$i$be = $159; $$1176$i$be = $158
                    }
                    $$1174$i = $$1174$i$be; $$1176$i = $$1176$i$be
                  }
                  HEAP32[$$1176$i >> 2] = 0
                  $$3$i = $$1174$i
                } else {
                  $148 = ((($$0170$i)) + 8 | 0)
                  $149 = HEAP32[$148 >> 2] | 0
                  $150 = ((($149)) + 12 | 0)
                  HEAP32[$150 >> 2] = $146
                  $151 = ((($146)) + 8 | 0)
                  HEAP32[$151 >> 2] = $149
                  $$3$i = $146
                }
              } while (0)
              $164 = ($144 | 0) == (0 | 0)
              do {
                if (!($164)) {
                  $165 = ((($$0170$i)) + 28 | 0)
                  $166 = HEAP32[$165 >> 2] | 0
                  $167 = (1536 + ($166 << 2) | 0)
                  $168 = HEAP32[$167 >> 2] | 0
                  $169 = ($$0170$i | 0) == ($168 | 0)
                  if ($169) {
                    HEAP32[$167 >> 2] = $$3$i
                    $cond$i = ($$3$i | 0) == (0 | 0)
                    if ($cond$i) {
                      $170 = 1 << $166
                      $171 = $170 ^ -1
                      $172 = $98 & $171
                      HEAP32[(1236) >> 2] = $172
                      break
                    }
                  } else {
                    $173 = ((($144)) + 16 | 0)
                    $174 = HEAP32[$173 >> 2] | 0
                    $175 = ($174 | 0) == ($$0170$i | 0)
                    $176 = ((($144)) + 20 | 0)
                    $$sink = $175 ? $173 : $176
                    HEAP32[$$sink >> 2] = $$3$i
                    $177 = ($$3$i | 0) == (0 | 0)
                    if ($177) {
                      break
                    }
                  }
                  $178 = ((($$3$i)) + 24 | 0)
                  HEAP32[$178 >> 2] = $144
                  $179 = ((($$0170$i)) + 16 | 0)
                  $180 = HEAP32[$179 >> 2] | 0
                  $181 = ($180 | 0) == (0 | 0)
                  if (!($181)) {
                    $182 = ((($$3$i)) + 16 | 0)
                    HEAP32[$182 >> 2] = $180
                    $183 = ((($180)) + 24 | 0)
                    HEAP32[$183 >> 2] = $$3$i
                  }
                  $184 = ((($$0170$i)) + 20 | 0)
                  $185 = HEAP32[$184 >> 2] | 0
                  $186 = ($185 | 0) == (0 | 0)
                  if (!($186)) {
                    $187 = ((($$3$i)) + 20 | 0)
                    HEAP32[$187 >> 2] = $185
                    $188 = ((($185)) + 24 | 0)
                    HEAP32[$188 >> 2] = $$3$i
                  }
                }
              } while (0)
              $189 = ($$0171$i >>> 0) < (16)
              if ($189) {
                $190 = (($$0171$i) + ($6)) | 0
                $191 = $190 | 3
                $192 = ((($$0170$i)) + 4 | 0)
                HEAP32[$192 >> 2] = $191
                $193 = (($$0170$i) + ($190) | 0)
                $194 = ((($193)) + 4 | 0)
                $195 = HEAP32[$194 >> 2] | 0
                $196 = $195 | 1
                HEAP32[$194 >> 2] = $196
              } else {
                $197 = $6 | 3
                $198 = ((($$0170$i)) + 4 | 0)
                HEAP32[$198 >> 2] = $197
                $199 = $$0171$i | 1
                $200 = ((($141)) + 4 | 0)
                HEAP32[$200 >> 2] = $199
                $201 = (($141) + ($$0171$i) | 0)
                HEAP32[$201 >> 2] = $$0171$i
                $202 = ($33 | 0) == (0)
                if (!($202)) {
                  $203 = HEAP32[(1252) >> 2] | 0
                  $204 = $33 >>> 3
                  $205 = $204 << 1
                  $206 = (1272 + ($205 << 2) | 0)
                  $207 = 1 << $204
                  $208 = $207 & $8
                  $209 = ($208 | 0) == (0)
                  if ($209) {
                    $210 = $207 | $8
                    HEAP32[308] = $210
                    $$pre$i = ((($206)) + 8 | 0)
                    $$0$i = $206; $$pre$phi$iZ2D = $$pre$i
                  } else {
                    $211 = ((($206)) + 8 | 0)
                    $212 = HEAP32[$211 >> 2] | 0
                    $$0$i = $212; $$pre$phi$iZ2D = $211
                  }
                  HEAP32[$$pre$phi$iZ2D >> 2] = $203
                  $213 = ((($$0$i)) + 12 | 0)
                  HEAP32[$213 >> 2] = $203
                  $214 = ((($203)) + 8 | 0)
                  HEAP32[$214 >> 2] = $$0$i
                  $215 = ((($203)) + 12 | 0)
                  HEAP32[$215 >> 2] = $206
                }
                HEAP32[(1240) >> 2] = $$0171$i
                HEAP32[(1252) >> 2] = $141
              }
              $216 = ((($$0170$i)) + 8 | 0)
              $$0 = $216
              STACKTOP = sp; return ($$0 | 0)
            } else {
              $$0192 = $6
            }
          }
        } else {
          $$0192 = $6
        }
      } else {
        $217 = ($0 >>> 0) > (4294967231)
        if ($217) {
          $$0192 = -1
        } else {
          $218 = (($0) + 11) | 0
          $219 = $218 & -8
          $220 = HEAP32[(1236) >> 2] | 0
          $221 = ($220 | 0) == (0)
          if ($221) {
            $$0192 = $219
          } else {
            $222 = (0 - ($219)) | 0
            $223 = $218 >>> 8
            $224 = ($223 | 0) == (0)
            if ($224) {
              $$0335$i = 0
            } else {
              $225 = ($219 >>> 0) > (16777215)
              if ($225) {
                $$0335$i = 31
              } else {
                $226 = (($223) + 1048320) | 0
                $227 = $226 >>> 16
                $228 = $227 & 8
                $229 = $223 << $228
                $230 = (($229) + 520192) | 0
                $231 = $230 >>> 16
                $232 = $231 & 4
                $233 = $232 | $228
                $234 = $229 << $232
                $235 = (($234) + 245760) | 0
                $236 = $235 >>> 16
                $237 = $236 & 2
                $238 = $233 | $237
                $239 = (14 - ($238)) | 0
                $240 = $234 << $237
                $241 = $240 >>> 15
                $242 = (($239) + ($241)) | 0
                $243 = $242 << 1
                $244 = (($242) + 7) | 0
                $245 = $219 >>> $244
                $246 = $245 & 1
                $247 = $246 | $243
                $$0335$i = $247
              }
            }
            $248 = (1536 + ($$0335$i << 2) | 0)
            $249 = HEAP32[$248 >> 2] | 0
            $250 = ($249 | 0) == (0 | 0)
            L79: do {
              if ($250) {
                $$2331$i = 0; $$3$i198 = 0; $$3326$i = $222
                label = 61
              } else {
                $251 = ($$0335$i | 0) == (31)
                $252 = $$0335$i >>> 1
                $253 = (25 - ($252)) | 0
                $254 = $251 ? 0 : $253
                $255 = $219 << $254
                $$0318$i = 0; $$0323$i = $222; $$0329$i = $249; $$0336$i = $255; $$0339$i = 0
                while (1) {
                  $256 = ((($$0329$i)) + 4 | 0)
                  $257 = HEAP32[$256 >> 2] | 0
                  $258 = $257 & -8
                  $259 = (($258) - ($219)) | 0
                  $260 = ($259 >>> 0) < ($$0323$i >>> 0)
                  if ($260) {
                    $261 = ($259 | 0) == (0)
                    if ($261) {
                      $$415$i$ph = $$0329$i; $$432714$i$ph = 0; $$533413$i$ph = $$0329$i
                      label = 65
                      break L79
                    } else {
                      $$1319$i = $$0329$i; $$1324$i = $259
                    }
                  } else {
                    $$1319$i = $$0318$i; $$1324$i = $$0323$i
                  }
                  $262 = ((($$0329$i)) + 20 | 0)
                  $263 = HEAP32[$262 >> 2] | 0
                  $264 = $$0336$i >>> 31
                  $265 = (((($$0329$i)) + 16 | 0) + ($264 << 2) | 0)
                  $266 = HEAP32[$265 >> 2] | 0
                  $267 = ($263 | 0) == (0 | 0)
                  $268 = ($263 | 0) == ($266 | 0)
                  $or$cond1$i197 = $267 | $268
                  $$1340$i = $or$cond1$i197 ? $$0339$i : $263
                  $269 = ($266 | 0) == (0 | 0)
                  $spec$select4$i = $$0336$i << 1
                  if ($269) {
                    $$2331$i = $$1340$i; $$3$i198 = $$1319$i; $$3326$i = $$1324$i
                    label = 61
                    break
                  } else {
                    $$0318$i = $$1319$i; $$0323$i = $$1324$i; $$0329$i = $266; $$0336$i = $spec$select4$i; $$0339$i = $$1340$i
                  }
                }
              }
            } while (0)
            if ((label | 0) == 61) {
              $270 = ($$2331$i | 0) == (0 | 0)
              $271 = ($$3$i198 | 0) == (0 | 0)
              $or$cond$i199 = $270 & $271
              if ($or$cond$i199) {
                $272 = 2 << $$0335$i
                $273 = (0 - ($272)) | 0
                $274 = $272 | $273
                $275 = $274 & $220
                $276 = ($275 | 0) == (0)
                if ($276) {
                  $$0192 = $219
                  break
                }
                $277 = (0 - ($275)) | 0
                $278 = $275 & $277
                $279 = (($278) + -1) | 0
                $280 = $279 >>> 12
                $281 = $280 & 16
                $282 = $279 >>> $281
                $283 = $282 >>> 5
                $284 = $283 & 8
                $285 = $284 | $281
                $286 = $282 >>> $284
                $287 = $286 >>> 2
                $288 = $287 & 4
                $289 = $285 | $288
                $290 = $286 >>> $288
                $291 = $290 >>> 1
                $292 = $291 & 2
                $293 = $289 | $292
                $294 = $290 >>> $292
                $295 = $294 >>> 1
                $296 = $295 & 1
                $297 = $293 | $296
                $298 = $294 >>> $296
                $299 = (($297) + ($298)) | 0
                $300 = (1536 + ($299 << 2) | 0)
                $301 = HEAP32[$300 >> 2] | 0
                $$3$i198211 = 0; $$4333$i = $301
              } else {
                $$3$i198211 = $$3$i198; $$4333$i = $$2331$i
              }
              $302 = ($$4333$i | 0) == (0 | 0)
              if ($302) {
                $$4$lcssa$i = $$3$i198211; $$4327$lcssa$i = $$3326$i
              } else {
                $$415$i$ph = $$3$i198211; $$432714$i$ph = $$3326$i; $$533413$i$ph = $$4333$i
                label = 65
              }
            }
            if ((label | 0) == 65) {
              $$415$i = $$415$i$ph; $$432714$i = $$432714$i$ph; $$533413$i = $$533413$i$ph
              while (1) {
                $303 = ((($$533413$i)) + 4 | 0)
                $304 = HEAP32[$303 >> 2] | 0
                $305 = $304 & -8
                $306 = (($305) - ($219)) | 0
                $307 = ($306 >>> 0) < ($$432714$i >>> 0)
                $spec$select$i201 = $307 ? $306 : $$432714$i
                $spec$select2$i = $307 ? $$533413$i : $$415$i
                $308 = ((($$533413$i)) + 16 | 0)
                $309 = HEAP32[$308 >> 2] | 0
                $310 = ($309 | 0) == (0 | 0)
                if ($310) {
                  $311 = ((($$533413$i)) + 20 | 0)
                  $312 = HEAP32[$311 >> 2] | 0
                  $314 = $312
                } else {
                  $314 = $309
                }
                $313 = ($314 | 0) == (0 | 0)
                if ($313) {
                  $$4$lcssa$i = $spec$select2$i; $$4327$lcssa$i = $spec$select$i201
                  break
                } else {
                  $$415$i = $spec$select2$i; $$432714$i = $spec$select$i201; $$533413$i = $314
                }
              }
            }
            $315 = ($$4$lcssa$i | 0) == (0 | 0)
            if ($315) {
              $$0192 = $219
            } else {
              $316 = HEAP32[(1240) >> 2] | 0
              $317 = (($316) - ($219)) | 0
              $318 = ($$4327$lcssa$i >>> 0) < ($317 >>> 0)
              if ($318) {
                $319 = (($$4$lcssa$i) + ($219) | 0)
                $320 = ($319 >>> 0) > ($$4$lcssa$i >>> 0)
                if ($320) {
                  $321 = ((($$4$lcssa$i)) + 24 | 0)
                  $322 = HEAP32[$321 >> 2] | 0
                  $323 = ((($$4$lcssa$i)) + 12 | 0)
                  $324 = HEAP32[$323 >> 2] | 0
                  $325 = ($324 | 0) == ($$4$lcssa$i | 0)
                  do {
                    if ($325) {
                      $330 = ((($$4$lcssa$i)) + 20 | 0)
                      $331 = HEAP32[$330 >> 2] | 0
                      $332 = ($331 | 0) == (0 | 0)
                      if ($332) {
                        $333 = ((($$4$lcssa$i)) + 16 | 0)
                        $334 = HEAP32[$333 >> 2] | 0
                        $335 = ($334 | 0) == (0 | 0)
                        if ($335) {
                          $$3348$i = 0
                          break
                        } else {
                          $$1346$i$ph = $334; $$1350$i$ph = $333
                        }
                      } else {
                        $$1346$i$ph = $331; $$1350$i$ph = $330
                      }
                      $$1346$i = $$1346$i$ph; $$1350$i = $$1350$i$ph
                      while (1) {
                        $336 = ((($$1346$i)) + 20 | 0)
                        $337 = HEAP32[$336 >> 2] | 0
                        $338 = ($337 | 0) == (0 | 0)
                        if ($338) {
                          $339 = ((($$1346$i)) + 16 | 0)
                          $340 = HEAP32[$339 >> 2] | 0
                          $341 = ($340 | 0) == (0 | 0)
                          if ($341) {
                            break
                          } else {
                            $$1346$i$be = $340; $$1350$i$be = $339
                          }
                        } else {
                          $$1346$i$be = $337; $$1350$i$be = $336
                        }
                        $$1346$i = $$1346$i$be; $$1350$i = $$1350$i$be
                      }
                      HEAP32[$$1350$i >> 2] = 0
                      $$3348$i = $$1346$i
                    } else {
                      $326 = ((($$4$lcssa$i)) + 8 | 0)
                      $327 = HEAP32[$326 >> 2] | 0
                      $328 = ((($327)) + 12 | 0)
                      HEAP32[$328 >> 2] = $324
                      $329 = ((($324)) + 8 | 0)
                      HEAP32[$329 >> 2] = $327
                      $$3348$i = $324
                    }
                  } while (0)
                  $342 = ($322 | 0) == (0 | 0)
                  do {
                    if ($342) {
                      $425 = $220
                    } else {
                      $343 = ((($$4$lcssa$i)) + 28 | 0)
                      $344 = HEAP32[$343 >> 2] | 0
                      $345 = (1536 + ($344 << 2) | 0)
                      $346 = HEAP32[$345 >> 2] | 0
                      $347 = ($$4$lcssa$i | 0) == ($346 | 0)
                      if ($347) {
                        HEAP32[$345 >> 2] = $$3348$i
                        $cond$i203 = ($$3348$i | 0) == (0 | 0)
                        if ($cond$i203) {
                          $348 = 1 << $344
                          $349 = $348 ^ -1
                          $350 = $220 & $349
                          HEAP32[(1236) >> 2] = $350
                          $425 = $350
                          break
                        }
                      } else {
                        $351 = ((($322)) + 16 | 0)
                        $352 = HEAP32[$351 >> 2] | 0
                        $353 = ($352 | 0) == ($$4$lcssa$i | 0)
                        $354 = ((($322)) + 20 | 0)
                        $$sink320 = $353 ? $351 : $354
                        HEAP32[$$sink320 >> 2] = $$3348$i
                        $355 = ($$3348$i | 0) == (0 | 0)
                        if ($355) {
                          $425 = $220
                          break
                        }
                      }
                      $356 = ((($$3348$i)) + 24 | 0)
                      HEAP32[$356 >> 2] = $322
                      $357 = ((($$4$lcssa$i)) + 16 | 0)
                      $358 = HEAP32[$357 >> 2] | 0
                      $359 = ($358 | 0) == (0 | 0)
                      if (!($359)) {
                        $360 = ((($$3348$i)) + 16 | 0)
                        HEAP32[$360 >> 2] = $358
                        $361 = ((($358)) + 24 | 0)
                        HEAP32[$361 >> 2] = $$3348$i
                      }
                      $362 = ((($$4$lcssa$i)) + 20 | 0)
                      $363 = HEAP32[$362 >> 2] | 0
                      $364 = ($363 | 0) == (0 | 0)
                      if ($364) {
                        $425 = $220
                      } else {
                        $365 = ((($$3348$i)) + 20 | 0)
                        HEAP32[$365 >> 2] = $363
                        $366 = ((($363)) + 24 | 0)
                        HEAP32[$366 >> 2] = $$3348$i
                        $425 = $220
                      }
                    }
                  } while (0)
                  $367 = ($$4327$lcssa$i >>> 0) < (16)
                  L128: do {
                    if ($367) {
                      $368 = (($$4327$lcssa$i) + ($219)) | 0
                      $369 = $368 | 3
                      $370 = ((($$4$lcssa$i)) + 4 | 0)
                      HEAP32[$370 >> 2] = $369
                      $371 = (($$4$lcssa$i) + ($368) | 0)
                      $372 = ((($371)) + 4 | 0)
                      $373 = HEAP32[$372 >> 2] | 0
                      $374 = $373 | 1
                      HEAP32[$372 >> 2] = $374
                    } else {
                      $375 = $219 | 3
                      $376 = ((($$4$lcssa$i)) + 4 | 0)
                      HEAP32[$376 >> 2] = $375
                      $377 = $$4327$lcssa$i | 1
                      $378 = ((($319)) + 4 | 0)
                      HEAP32[$378 >> 2] = $377
                      $379 = (($319) + ($$4327$lcssa$i) | 0)
                      HEAP32[$379 >> 2] = $$4327$lcssa$i
                      $380 = $$4327$lcssa$i >>> 3
                      $381 = ($$4327$lcssa$i >>> 0) < (256)
                      if ($381) {
                        $382 = $380 << 1
                        $383 = (1272 + ($382 << 2) | 0)
                        $384 = HEAP32[308] | 0
                        $385 = 1 << $380
                        $386 = $384 & $385
                        $387 = ($386 | 0) == (0)
                        if ($387) {
                          $388 = $384 | $385
                          HEAP32[308] = $388
                          $$pre$i204 = ((($383)) + 8 | 0)
                          $$0344$i = $383; $$pre$phi$i205Z2D = $$pre$i204
                        } else {
                          $389 = ((($383)) + 8 | 0)
                          $390 = HEAP32[$389 >> 2] | 0
                          $$0344$i = $390; $$pre$phi$i205Z2D = $389
                        }
                        HEAP32[$$pre$phi$i205Z2D >> 2] = $319
                        $391 = ((($$0344$i)) + 12 | 0)
                        HEAP32[$391 >> 2] = $319
                        $392 = ((($319)) + 8 | 0)
                        HEAP32[$392 >> 2] = $$0344$i
                        $393 = ((($319)) + 12 | 0)
                        HEAP32[$393 >> 2] = $383
                        break
                      }
                      $394 = $$4327$lcssa$i >>> 8
                      $395 = ($394 | 0) == (0)
                      if ($395) {
                        $$0338$i = 0
                      } else {
                        $396 = ($$4327$lcssa$i >>> 0) > (16777215)
                        if ($396) {
                          $$0338$i = 31
                        } else {
                          $397 = (($394) + 1048320) | 0
                          $398 = $397 >>> 16
                          $399 = $398 & 8
                          $400 = $394 << $399
                          $401 = (($400) + 520192) | 0
                          $402 = $401 >>> 16
                          $403 = $402 & 4
                          $404 = $403 | $399
                          $405 = $400 << $403
                          $406 = (($405) + 245760) | 0
                          $407 = $406 >>> 16
                          $408 = $407 & 2
                          $409 = $404 | $408
                          $410 = (14 - ($409)) | 0
                          $411 = $405 << $408
                          $412 = $411 >>> 15
                          $413 = (($410) + ($412)) | 0
                          $414 = $413 << 1
                          $415 = (($413) + 7) | 0
                          $416 = $$4327$lcssa$i >>> $415
                          $417 = $416 & 1
                          $418 = $417 | $414
                          $$0338$i = $418
                        }
                      }
                      $419 = (1536 + ($$0338$i << 2) | 0)
                      $420 = ((($319)) + 28 | 0)
                      HEAP32[$420 >> 2] = $$0338$i
                      $421 = ((($319)) + 16 | 0)
                      $422 = ((($421)) + 4 | 0)
                      HEAP32[$422 >> 2] = 0
                      HEAP32[$421 >> 2] = 0
                      $423 = 1 << $$0338$i
                      $424 = $425 & $423
                      $426 = ($424 | 0) == (0)
                      if ($426) {
                        $427 = $425 | $423
                        HEAP32[(1236) >> 2] = $427
                        HEAP32[$419 >> 2] = $319
                        $428 = ((($319)) + 24 | 0)
                        HEAP32[$428 >> 2] = $419
                        $429 = ((($319)) + 12 | 0)
                        HEAP32[$429 >> 2] = $319
                        $430 = ((($319)) + 8 | 0)
                        HEAP32[$430 >> 2] = $319
                        break
                      }
                      $431 = HEAP32[$419 >> 2] | 0
                      $432 = ((($431)) + 4 | 0)
                      $433 = HEAP32[$432 >> 2] | 0
                      $434 = $433 & -8
                      $435 = ($434 | 0) == ($$4327$lcssa$i | 0)
                      L145: do {
                        if ($435) {
                          $$0321$lcssa$i = $431
                        } else {
                          $436 = ($$0338$i | 0) == (31)
                          $437 = $$0338$i >>> 1
                          $438 = (25 - ($437)) | 0
                          $439 = $436 ? 0 : $438
                          $440 = $$4327$lcssa$i << $439
                          $$032012$i = $440; $$032111$i = $431
                          while (1) {
                            $447 = $$032012$i >>> 31
                            $448 = (((($$032111$i)) + 16 | 0) + ($447 << 2) | 0)
                            $443 = HEAP32[$448 >> 2] | 0
                            $449 = ($443 | 0) == (0 | 0)
                            if ($449) {
                              break
                            }
                            $441 = $$032012$i << 1
                            $442 = ((($443)) + 4 | 0)
                            $444 = HEAP32[$442 >> 2] | 0
                            $445 = $444 & -8
                            $446 = ($445 | 0) == ($$4327$lcssa$i | 0)
                            if ($446) {
                              $$0321$lcssa$i = $443
                              break L145
                            } else {
                              $$032012$i = $441; $$032111$i = $443
                            }
                          }
                          HEAP32[$448 >> 2] = $319
                          $450 = ((($319)) + 24 | 0)
                          HEAP32[$450 >> 2] = $$032111$i
                          $451 = ((($319)) + 12 | 0)
                          HEAP32[$451 >> 2] = $319
                          $452 = ((($319)) + 8 | 0)
                          HEAP32[$452 >> 2] = $319
                          break L128
                        }
                      } while (0)
                      $453 = ((($$0321$lcssa$i)) + 8 | 0)
                      $454 = HEAP32[$453 >> 2] | 0
                      $455 = ((($454)) + 12 | 0)
                      HEAP32[$455 >> 2] = $319
                      HEAP32[$453 >> 2] = $319
                      $456 = ((($319)) + 8 | 0)
                      HEAP32[$456 >> 2] = $454
                      $457 = ((($319)) + 12 | 0)
                      HEAP32[$457 >> 2] = $$0321$lcssa$i
                      $458 = ((($319)) + 24 | 0)
                      HEAP32[$458 >> 2] = 0
                    }
                  } while (0)
                  $459 = ((($$4$lcssa$i)) + 8 | 0)
                  $$0 = $459
                  STACKTOP = sp; return ($$0 | 0)
                } else {
                  $$0192 = $219
                }
              } else {
                $$0192 = $219
              }
            }
          }
        }
      }
    } while (0)
    $460 = HEAP32[(1240) >> 2] | 0
    $461 = ($460 >>> 0) < ($$0192 >>> 0)
    if (!($461)) {
      $462 = (($460) - ($$0192)) | 0
      $463 = HEAP32[(1252) >> 2] | 0
      $464 = ($462 >>> 0) > (15)
      if ($464) {
        $465 = (($463) + ($$0192) | 0)
        HEAP32[(1252) >> 2] = $465
        HEAP32[(1240) >> 2] = $462
        $466 = $462 | 1
        $467 = ((($465)) + 4 | 0)
        HEAP32[$467 >> 2] = $466
        $468 = (($463) + ($460) | 0)
        HEAP32[$468 >> 2] = $462
        $469 = $$0192 | 3
        $470 = ((($463)) + 4 | 0)
        HEAP32[$470 >> 2] = $469
      } else {
        HEAP32[(1240) >> 2] = 0
        HEAP32[(1252) >> 2] = 0
        $471 = $460 | 3
        $472 = ((($463)) + 4 | 0)
        HEAP32[$472 >> 2] = $471
        $473 = (($463) + ($460) | 0)
        $474 = ((($473)) + 4 | 0)
        $475 = HEAP32[$474 >> 2] | 0
        $476 = $475 | 1
        HEAP32[$474 >> 2] = $476
      }
      $477 = ((($463)) + 8 | 0)
      $$0 = $477
      STACKTOP = sp; return ($$0 | 0)
    }
    $478 = HEAP32[(1244) >> 2] | 0
    $479 = ($478 >>> 0) > ($$0192 >>> 0)
    if ($479) {
      $480 = (($478) - ($$0192)) | 0
      HEAP32[(1244) >> 2] = $480
      $481 = HEAP32[(1256) >> 2] | 0
      $482 = (($481) + ($$0192) | 0)
      HEAP32[(1256) >> 2] = $482
      $483 = $480 | 1
      $484 = ((($482)) + 4 | 0)
      HEAP32[$484 >> 2] = $483
      $485 = $$0192 | 3
      $486 = ((($481)) + 4 | 0)
      HEAP32[$486 >> 2] = $485
      $487 = ((($481)) + 8 | 0)
      $$0 = $487
      STACKTOP = sp; return ($$0 | 0)
    }
    $488 = HEAP32[426] | 0
    $489 = ($488 | 0) == (0)
    if ($489) {
      HEAP32[(1712) >> 2] = 4096
      HEAP32[(1708) >> 2] = 4096
      HEAP32[(1716) >> 2] = -1
      HEAP32[(1720) >> 2] = -1
      HEAP32[(1724) >> 2] = 0
      HEAP32[(1676) >> 2] = 0
      $490 = $1
      $491 = $490 & -16
      $492 = $491 ^ 1431655768
      HEAP32[426] = $492
      $496 = 4096
    } else {
      $$pre$i195 = HEAP32[(1712) >> 2] | 0
      $496 = $$pre$i195
    }
    $493 = (($$0192) + 48) | 0
    $494 = (($$0192) + 47) | 0
    $495 = (($496) + ($494)) | 0
    $497 = (0 - ($496)) | 0
    $498 = $495 & $497
    $499 = ($498 >>> 0) > ($$0192 >>> 0)
    if (!($499)) {
      $$0 = 0
      STACKTOP = sp; return ($$0 | 0)
    }
    $500 = HEAP32[(1672) >> 2] | 0
    $501 = ($500 | 0) == (0)
    if (!($501)) {
      $502 = HEAP32[(1664) >> 2] | 0
      $503 = (($502) + ($498)) | 0
      $504 = ($503 >>> 0) <= ($502 >>> 0)
      $505 = ($503 >>> 0) > ($500 >>> 0)
      $or$cond1$i = $504 | $505
      if ($or$cond1$i) {
        $$0 = 0
        STACKTOP = sp; return ($$0 | 0)
      }
    }
    $506 = HEAP32[(1676) >> 2] | 0
    $507 = $506 & 4
    $508 = ($507 | 0) == (0)
    L178: do {
      if ($508) {
        $509 = HEAP32[(1256) >> 2] | 0
        $510 = ($509 | 0) == (0 | 0)
        L180: do {
          if ($510) {
            label = 128
          } else {
            $$0$i20$i = (1680)
            while (1) {
              $511 = HEAP32[$$0$i20$i >> 2] | 0
              $512 = ($511 >>> 0) > ($509 >>> 0)
              if (!($512)) {
                $513 = ((($$0$i20$i)) + 4 | 0)
                $514 = HEAP32[$513 >> 2] | 0
                $515 = (($511) + ($514) | 0)
                $516 = ($515 >>> 0) > ($509 >>> 0)
                if ($516) {
                  break
                }
              }
              $517 = ((($$0$i20$i)) + 8 | 0)
              $518 = HEAP32[$517 >> 2] | 0
              $519 = ($518 | 0) == (0 | 0)
              if ($519) {
                label = 128
                break L180
              } else {
                $$0$i20$i = $518
              }
            }
            $542 = (($495) - ($478)) | 0
            $543 = $542 & $497
            $544 = ($543 >>> 0) < (2147483647)
            if ($544) {
              $545 = ((($$0$i20$i)) + 4 | 0)
              $546 = (_sbrk($543) | 0)
              $547 = HEAP32[$$0$i20$i >> 2] | 0
              $548 = HEAP32[$545 >> 2] | 0
              $549 = (($547) + ($548) | 0)
              $550 = ($546 | 0) == ($549 | 0)
              if ($550) {
                $551 = ($546 | 0) == ((-1) | 0)
                if ($551) {
                  $$2234243136$i = $543
                } else {
                  $$723947$i = $543; $$748$i = $546
                  label = 145
                  break L178
                }
              } else {
                $$2247$ph$i = $546; $$2253$ph$i = $543
                label = 136
              }
            } else {
              $$2234243136$i = 0
            }
          }
        } while (0)
        do {
          if ((label | 0) == 128) {
            $520 = (_sbrk(0) | 0)
            $521 = ($520 | 0) == ((-1) | 0)
            if ($521) {
              $$2234243136$i = 0
            } else {
              $522 = $520
              $523 = HEAP32[(1708) >> 2] | 0
              $524 = (($523) + -1) | 0
              $525 = $524 & $522
              $526 = ($525 | 0) == (0)
              $527 = (($524) + ($522)) | 0
              $528 = (0 - ($523)) | 0
              $529 = $527 & $528
              $530 = (($529) - ($522)) | 0
              $531 = $526 ? 0 : $530
              $spec$select49$i = (($531) + ($498)) | 0
              $532 = HEAP32[(1664) >> 2] | 0
              $533 = (($spec$select49$i) + ($532)) | 0
              $534 = ($spec$select49$i >>> 0) > ($$0192 >>> 0)
              $535 = ($spec$select49$i >>> 0) < (2147483647)
              $or$cond$i = $534 & $535
              if ($or$cond$i) {
                $536 = HEAP32[(1672) >> 2] | 0
                $537 = ($536 | 0) == (0)
                if (!($537)) {
                  $538 = ($533 >>> 0) <= ($532 >>> 0)
                  $539 = ($533 >>> 0) > ($536 >>> 0)
                  $or$cond2$i = $538 | $539
                  if ($or$cond2$i) {
                    $$2234243136$i = 0
                    break
                  }
                }
                $540 = (_sbrk($spec$select49$i) | 0)
                $541 = ($540 | 0) == ($520 | 0)
                if ($541) {
                  $$723947$i = $spec$select49$i; $$748$i = $520
                  label = 145
                  break L178
                } else {
                  $$2247$ph$i = $540; $$2253$ph$i = $spec$select49$i
                  label = 136
                }
              } else {
                $$2234243136$i = 0
              }
            }
          }
        } while (0)
        do {
          if ((label | 0) == 136) {
            $552 = (0 - ($$2253$ph$i)) | 0
            $553 = ($$2247$ph$i | 0) != ((-1) | 0)
            $554 = ($$2253$ph$i >>> 0) < (2147483647)
            $or$cond7$i = $554 & $553
            $555 = ($493 >>> 0) > ($$2253$ph$i >>> 0)
            $or$cond6$i = $555 & $or$cond7$i
            if (!($or$cond6$i)) {
              $565 = ($$2247$ph$i | 0) == ((-1) | 0)
              if ($565) {
                $$2234243136$i = 0
                break
              } else {
                $$723947$i = $$2253$ph$i; $$748$i = $$2247$ph$i
                label = 145
                break L178
              }
            }
            $556 = HEAP32[(1712) >> 2] | 0
            $557 = (($494) - ($$2253$ph$i)) | 0
            $558 = (($557) + ($556)) | 0
            $559 = (0 - ($556)) | 0
            $560 = $558 & $559
            $561 = ($560 >>> 0) < (2147483647)
            if (!($561)) {
              $$723947$i = $$2253$ph$i; $$748$i = $$2247$ph$i
              label = 145
              break L178
            }
            $562 = (_sbrk($560) | 0)
            $563 = ($562 | 0) == ((-1) | 0)
            if ($563) {
              (_sbrk($552) | 0)
              $$2234243136$i = 0
              break
            } else {
              $564 = (($560) + ($$2253$ph$i)) | 0
              $$723947$i = $564; $$748$i = $$2247$ph$i
              label = 145
              break L178
            }
          }
        } while (0)
        $566 = HEAP32[(1676) >> 2] | 0
        $567 = $566 | 4
        HEAP32[(1676) >> 2] = $567
        $$4236$i = $$2234243136$i
        label = 143
      } else {
        $$4236$i = 0
        label = 143
      }
    } while (0)
    if ((label | 0) == 143) {
      $568 = ($498 >>> 0) < (2147483647)
      if ($568) {
        $569 = (_sbrk($498) | 0)
        $570 = (_sbrk(0) | 0)
        $571 = ($569 | 0) != ((-1) | 0)
        $572 = ($570 | 0) != ((-1) | 0)
        $or$cond5$i = $571 & $572
        $573 = ($569 >>> 0) < ($570 >>> 0)
        $or$cond8$i = $573 & $or$cond5$i
        $574 = $570
        $575 = $569
        $576 = (($574) - ($575)) | 0
        $577 = (($$0192) + 40) | 0
        $578 = ($576 >>> 0) > ($577 >>> 0)
        $spec$select9$i = $578 ? $576 : $$4236$i
        $or$cond8$not$i = $or$cond8$i ^ 1
        $579 = ($569 | 0) == ((-1) | 0)
        $not$$i = $578 ^ 1
        $580 = $579 | $not$$i
        $or$cond50$i = $580 | $or$cond8$not$i
        if (!($or$cond50$i)) {
          $$723947$i = $spec$select9$i; $$748$i = $569
          label = 145
        }
      }
    }
    if ((label | 0) == 145) {
      $581 = HEAP32[(1664) >> 2] | 0
      $582 = (($581) + ($$723947$i)) | 0
      HEAP32[(1664) >> 2] = $582
      $583 = HEAP32[(1668) >> 2] | 0
      $584 = ($582 >>> 0) > ($583 >>> 0)
      if ($584) {
        HEAP32[(1668) >> 2] = $582
      }
      $585 = HEAP32[(1256) >> 2] | 0
      $586 = ($585 | 0) == (0 | 0)
      L215: do {
        if ($586) {
          $587 = HEAP32[(1248) >> 2] | 0
          $588 = ($587 | 0) == (0 | 0)
          $589 = ($$748$i >>> 0) < ($587 >>> 0)
          $or$cond11$i = $588 | $589
          if ($or$cond11$i) {
            HEAP32[(1248) >> 2] = $$748$i
          }
          HEAP32[(1680) >> 2] = $$748$i
          HEAP32[(1684) >> 2] = $$723947$i
          HEAP32[(1692) >> 2] = 0
          $590 = HEAP32[426] | 0
          HEAP32[(1268) >> 2] = $590
          HEAP32[(1264) >> 2] = -1
          HEAP32[(1284) >> 2] = (1272)
          HEAP32[(1280) >> 2] = (1272)
          HEAP32[(1292) >> 2] = (1280)
          HEAP32[(1288) >> 2] = (1280)
          HEAP32[(1300) >> 2] = (1288)
          HEAP32[(1296) >> 2] = (1288)
          HEAP32[(1308) >> 2] = (1296)
          HEAP32[(1304) >> 2] = (1296)
          HEAP32[(1316) >> 2] = (1304)
          HEAP32[(1312) >> 2] = (1304)
          HEAP32[(1324) >> 2] = (1312)
          HEAP32[(1320) >> 2] = (1312)
          HEAP32[(1332) >> 2] = (1320)
          HEAP32[(1328) >> 2] = (1320)
          HEAP32[(1340) >> 2] = (1328)
          HEAP32[(1336) >> 2] = (1328)
          HEAP32[(1348) >> 2] = (1336)
          HEAP32[(1344) >> 2] = (1336)
          HEAP32[(1356) >> 2] = (1344)
          HEAP32[(1352) >> 2] = (1344)
          HEAP32[(1364) >> 2] = (1352)
          HEAP32[(1360) >> 2] = (1352)
          HEAP32[(1372) >> 2] = (1360)
          HEAP32[(1368) >> 2] = (1360)
          HEAP32[(1380) >> 2] = (1368)
          HEAP32[(1376) >> 2] = (1368)
          HEAP32[(1388) >> 2] = (1376)
          HEAP32[(1384) >> 2] = (1376)
          HEAP32[(1396) >> 2] = (1384)
          HEAP32[(1392) >> 2] = (1384)
          HEAP32[(1404) >> 2] = (1392)
          HEAP32[(1400) >> 2] = (1392)
          HEAP32[(1412) >> 2] = (1400)
          HEAP32[(1408) >> 2] = (1400)
          HEAP32[(1420) >> 2] = (1408)
          HEAP32[(1416) >> 2] = (1408)
          HEAP32[(1428) >> 2] = (1416)
          HEAP32[(1424) >> 2] = (1416)
          HEAP32[(1436) >> 2] = (1424)
          HEAP32[(1432) >> 2] = (1424)
          HEAP32[(1444) >> 2] = (1432)
          HEAP32[(1440) >> 2] = (1432)
          HEAP32[(1452) >> 2] = (1440)
          HEAP32[(1448) >> 2] = (1440)
          HEAP32[(1460) >> 2] = (1448)
          HEAP32[(1456) >> 2] = (1448)
          HEAP32[(1468) >> 2] = (1456)
          HEAP32[(1464) >> 2] = (1456)
          HEAP32[(1476) >> 2] = (1464)
          HEAP32[(1472) >> 2] = (1464)
          HEAP32[(1484) >> 2] = (1472)
          HEAP32[(1480) >> 2] = (1472)
          HEAP32[(1492) >> 2] = (1480)
          HEAP32[(1488) >> 2] = (1480)
          HEAP32[(1500) >> 2] = (1488)
          HEAP32[(1496) >> 2] = (1488)
          HEAP32[(1508) >> 2] = (1496)
          HEAP32[(1504) >> 2] = (1496)
          HEAP32[(1516) >> 2] = (1504)
          HEAP32[(1512) >> 2] = (1504)
          HEAP32[(1524) >> 2] = (1512)
          HEAP32[(1520) >> 2] = (1512)
          HEAP32[(1532) >> 2] = (1520)
          HEAP32[(1528) >> 2] = (1520)
          $591 = (($$723947$i) + -40) | 0
          $592 = ((($$748$i)) + 8 | 0)
          $593 = $592
          $594 = $593 & 7
          $595 = ($594 | 0) == (0)
          $596 = (0 - ($593)) | 0
          $597 = $596 & 7
          $598 = $595 ? 0 : $597
          $599 = (($$748$i) + ($598) | 0)
          $600 = (($591) - ($598)) | 0
          HEAP32[(1256) >> 2] = $599
          HEAP32[(1244) >> 2] = $600
          $601 = $600 | 1
          $602 = ((($599)) + 4 | 0)
          HEAP32[$602 >> 2] = $601
          $603 = (($$748$i) + ($591) | 0)
          $604 = ((($603)) + 4 | 0)
          HEAP32[$604 >> 2] = 40
          $605 = HEAP32[(1720) >> 2] | 0
          HEAP32[(1260) >> 2] = $605
        } else {
          $$024372$i = (1680)
          while (1) {
            $606 = HEAP32[$$024372$i >> 2] | 0
            $607 = ((($$024372$i)) + 4 | 0)
            $608 = HEAP32[$607 >> 2] | 0
            $609 = (($606) + ($608) | 0)
            $610 = ($$748$i | 0) == ($609 | 0)
            if ($610) {
              label = 154
              break
            }
            $611 = ((($$024372$i)) + 8 | 0)
            $612 = HEAP32[$611 >> 2] | 0
            $613 = ($612 | 0) == (0 | 0)
            if ($613) {
              break
            } else {
              $$024372$i = $612
            }
          }
          if ((label | 0) == 154) {
            $614 = ((($$024372$i)) + 4 | 0)
            $615 = ((($$024372$i)) + 12 | 0)
            $616 = HEAP32[$615 >> 2] | 0
            $617 = $616 & 8
            $618 = ($617 | 0) == (0)
            if ($618) {
              $619 = ($606 >>> 0) <= ($585 >>> 0)
              $620 = ($$748$i >>> 0) > ($585 >>> 0)
              $or$cond51$i = $620 & $619
              if ($or$cond51$i) {
                $621 = (($608) + ($$723947$i)) | 0
                HEAP32[$614 >> 2] = $621
                $622 = HEAP32[(1244) >> 2] | 0
                $623 = (($622) + ($$723947$i)) | 0
                $624 = ((($585)) + 8 | 0)
                $625 = $624
                $626 = $625 & 7
                $627 = ($626 | 0) == (0)
                $628 = (0 - ($625)) | 0
                $629 = $628 & 7
                $630 = $627 ? 0 : $629
                $631 = (($585) + ($630) | 0)
                $632 = (($623) - ($630)) | 0
                HEAP32[(1256) >> 2] = $631
                HEAP32[(1244) >> 2] = $632
                $633 = $632 | 1
                $634 = ((($631)) + 4 | 0)
                HEAP32[$634 >> 2] = $633
                $635 = (($585) + ($623) | 0)
                $636 = ((($635)) + 4 | 0)
                HEAP32[$636 >> 2] = 40
                $637 = HEAP32[(1720) >> 2] | 0
                HEAP32[(1260) >> 2] = $637
                break
              }
            }
          }
          $638 = HEAP32[(1248) >> 2] | 0
          $639 = ($$748$i >>> 0) < ($638 >>> 0)
          if ($639) {
            HEAP32[(1248) >> 2] = $$748$i
          }
          $640 = (($$748$i) + ($$723947$i) | 0)
          $$124471$i = (1680)
          while (1) {
            $641 = HEAP32[$$124471$i >> 2] | 0
            $642 = ($641 | 0) == ($640 | 0)
            if ($642) {
              label = 162
              break
            }
            $643 = ((($$124471$i)) + 8 | 0)
            $644 = HEAP32[$643 >> 2] | 0
            $645 = ($644 | 0) == (0 | 0)
            if ($645) {
              break
            } else {
              $$124471$i = $644
            }
          }
          if ((label | 0) == 162) {
            $646 = ((($$124471$i)) + 12 | 0)
            $647 = HEAP32[$646 >> 2] | 0
            $648 = $647 & 8
            $649 = ($648 | 0) == (0)
            if ($649) {
              HEAP32[$$124471$i >> 2] = $$748$i
              $650 = ((($$124471$i)) + 4 | 0)
              $651 = HEAP32[$650 >> 2] | 0
              $652 = (($651) + ($$723947$i)) | 0
              HEAP32[$650 >> 2] = $652
              $653 = ((($$748$i)) + 8 | 0)
              $654 = $653
              $655 = $654 & 7
              $656 = ($655 | 0) == (0)
              $657 = (0 - ($654)) | 0
              $658 = $657 & 7
              $659 = $656 ? 0 : $658
              $660 = (($$748$i) + ($659) | 0)
              $661 = ((($640)) + 8 | 0)
              $662 = $661
              $663 = $662 & 7
              $664 = ($663 | 0) == (0)
              $665 = (0 - ($662)) | 0
              $666 = $665 & 7
              $667 = $664 ? 0 : $666
              $668 = (($640) + ($667) | 0)
              $669 = $668
              $670 = $660
              $671 = (($669) - ($670)) | 0
              $672 = (($660) + ($$0192) | 0)
              $673 = (($671) - ($$0192)) | 0
              $674 = $$0192 | 3
              $675 = ((($660)) + 4 | 0)
              HEAP32[$675 >> 2] = $674
              $676 = ($585 | 0) == ($668 | 0)
              L238: do {
                if ($676) {
                  $677 = HEAP32[(1244) >> 2] | 0
                  $678 = (($677) + ($673)) | 0
                  HEAP32[(1244) >> 2] = $678
                  HEAP32[(1256) >> 2] = $672
                  $679 = $678 | 1
                  $680 = ((($672)) + 4 | 0)
                  HEAP32[$680 >> 2] = $679
                } else {
                  $681 = HEAP32[(1252) >> 2] | 0
                  $682 = ($681 | 0) == ($668 | 0)
                  if ($682) {
                    $683 = HEAP32[(1240) >> 2] | 0
                    $684 = (($683) + ($673)) | 0
                    HEAP32[(1240) >> 2] = $684
                    HEAP32[(1252) >> 2] = $672
                    $685 = $684 | 1
                    $686 = ((($672)) + 4 | 0)
                    HEAP32[$686 >> 2] = $685
                    $687 = (($672) + ($684) | 0)
                    HEAP32[$687 >> 2] = $684
                    break
                  }
                  $688 = ((($668)) + 4 | 0)
                  $689 = HEAP32[$688 >> 2] | 0
                  $690 = $689 & 3
                  $691 = ($690 | 0) == (1)
                  if ($691) {
                    $692 = $689 & -8
                    $693 = $689 >>> 3
                    $694 = ($689 >>> 0) < (256)
                    L246: do {
                      if ($694) {
                        $695 = ((($668)) + 8 | 0)
                        $696 = HEAP32[$695 >> 2] | 0
                        $697 = ((($668)) + 12 | 0)
                        $698 = HEAP32[$697 >> 2] | 0
                        $699 = ($698 | 0) == ($696 | 0)
                        if ($699) {
                          $700 = 1 << $693
                          $701 = $700 ^ -1
                          $702 = HEAP32[308] | 0
                          $703 = $702 & $701
                          HEAP32[308] = $703
                          break
                        } else {
                          $704 = ((($696)) + 12 | 0)
                          HEAP32[$704 >> 2] = $698
                          $705 = ((($698)) + 8 | 0)
                          HEAP32[$705 >> 2] = $696
                          break
                        }
                      } else {
                        $706 = ((($668)) + 24 | 0)
                        $707 = HEAP32[$706 >> 2] | 0
                        $708 = ((($668)) + 12 | 0)
                        $709 = HEAP32[$708 >> 2] | 0
                        $710 = ($709 | 0) == ($668 | 0)
                        do {
                          if ($710) {
                            $715 = ((($668)) + 16 | 0)
                            $716 = ((($715)) + 4 | 0)
                            $717 = HEAP32[$716 >> 2] | 0
                            $718 = ($717 | 0) == (0 | 0)
                            if ($718) {
                              $719 = HEAP32[$715 >> 2] | 0
                              $720 = ($719 | 0) == (0 | 0)
                              if ($720) {
                                $$3$i$i = 0
                                break
                              } else {
                                $$1263$i$i$ph = $719; $$1265$i$i$ph = $715
                              }
                            } else {
                              $$1263$i$i$ph = $717; $$1265$i$i$ph = $716
                            }
                            $$1263$i$i = $$1263$i$i$ph; $$1265$i$i = $$1265$i$i$ph
                            while (1) {
                              $721 = ((($$1263$i$i)) + 20 | 0)
                              $722 = HEAP32[$721 >> 2] | 0
                              $723 = ($722 | 0) == (0 | 0)
                              if ($723) {
                                $724 = ((($$1263$i$i)) + 16 | 0)
                                $725 = HEAP32[$724 >> 2] | 0
                                $726 = ($725 | 0) == (0 | 0)
                                if ($726) {
                                  break
                                } else {
                                  $$1263$i$i$be = $725; $$1265$i$i$be = $724
                                }
                              } else {
                                $$1263$i$i$be = $722; $$1265$i$i$be = $721
                              }
                              $$1263$i$i = $$1263$i$i$be; $$1265$i$i = $$1265$i$i$be
                            }
                            HEAP32[$$1265$i$i >> 2] = 0
                            $$3$i$i = $$1263$i$i
                          } else {
                            $711 = ((($668)) + 8 | 0)
                            $712 = HEAP32[$711 >> 2] | 0
                            $713 = ((($712)) + 12 | 0)
                            HEAP32[$713 >> 2] = $709
                            $714 = ((($709)) + 8 | 0)
                            HEAP32[$714 >> 2] = $712
                            $$3$i$i = $709
                          }
                        } while (0)
                        $727 = ($707 | 0) == (0 | 0)
                        if ($727) {
                          break
                        }
                        $728 = ((($668)) + 28 | 0)
                        $729 = HEAP32[$728 >> 2] | 0
                        $730 = (1536 + ($729 << 2) | 0)
                        $731 = HEAP32[$730 >> 2] | 0
                        $732 = ($731 | 0) == ($668 | 0)
                        do {
                          if ($732) {
                            HEAP32[$730 >> 2] = $$3$i$i
                            $cond$i$i = ($$3$i$i | 0) == (0 | 0)
                            if (!($cond$i$i)) {
                              break
                            }
                            $733 = 1 << $729
                            $734 = $733 ^ -1
                            $735 = HEAP32[(1236) >> 2] | 0
                            $736 = $735 & $734
                            HEAP32[(1236) >> 2] = $736
                            break L246
                          } else {
                            $737 = ((($707)) + 16 | 0)
                            $738 = HEAP32[$737 >> 2] | 0
                            $739 = ($738 | 0) == ($668 | 0)
                            $740 = ((($707)) + 20 | 0)
                            $$sink321 = $739 ? $737 : $740
                            HEAP32[$$sink321 >> 2] = $$3$i$i
                            $741 = ($$3$i$i | 0) == (0 | 0)
                            if ($741) {
                              break L246
                            }
                          }
                        } while (0)
                        $742 = ((($$3$i$i)) + 24 | 0)
                        HEAP32[$742 >> 2] = $707
                        $743 = ((($668)) + 16 | 0)
                        $744 = HEAP32[$743 >> 2] | 0
                        $745 = ($744 | 0) == (0 | 0)
                        if (!($745)) {
                          $746 = ((($$3$i$i)) + 16 | 0)
                          HEAP32[$746 >> 2] = $744
                          $747 = ((($744)) + 24 | 0)
                          HEAP32[$747 >> 2] = $$3$i$i
                        }
                        $748 = ((($743)) + 4 | 0)
                        $749 = HEAP32[$748 >> 2] | 0
                        $750 = ($749 | 0) == (0 | 0)
                        if ($750) {
                          break
                        }
                        $751 = ((($$3$i$i)) + 20 | 0)
                        HEAP32[$751 >> 2] = $749
                        $752 = ((($749)) + 24 | 0)
                        HEAP32[$752 >> 2] = $$3$i$i
                      }
                    } while (0)
                    $753 = (($668) + ($692) | 0)
                    $754 = (($692) + ($673)) | 0
                    $$0$i$i = $753; $$0259$i$i = $754
                  } else {
                    $$0$i$i = $668; $$0259$i$i = $673
                  }
                  $755 = ((($$0$i$i)) + 4 | 0)
                  $756 = HEAP32[$755 >> 2] | 0
                  $757 = $756 & -2
                  HEAP32[$755 >> 2] = $757
                  $758 = $$0259$i$i | 1
                  $759 = ((($672)) + 4 | 0)
                  HEAP32[$759 >> 2] = $758
                  $760 = (($672) + ($$0259$i$i) | 0)
                  HEAP32[$760 >> 2] = $$0259$i$i
                  $761 = $$0259$i$i >>> 3
                  $762 = ($$0259$i$i >>> 0) < (256)
                  if ($762) {
                    $763 = $761 << 1
                    $764 = (1272 + ($763 << 2) | 0)
                    $765 = HEAP32[308] | 0
                    $766 = 1 << $761
                    $767 = $765 & $766
                    $768 = ($767 | 0) == (0)
                    if ($768) {
                      $769 = $765 | $766
                      HEAP32[308] = $769
                      $$pre$i16$i = ((($764)) + 8 | 0)
                      $$0267$i$i = $764; $$pre$phi$i17$iZ2D = $$pre$i16$i
                    } else {
                      $770 = ((($764)) + 8 | 0)
                      $771 = HEAP32[$770 >> 2] | 0
                      $$0267$i$i = $771; $$pre$phi$i17$iZ2D = $770
                    }
                    HEAP32[$$pre$phi$i17$iZ2D >> 2] = $672
                    $772 = ((($$0267$i$i)) + 12 | 0)
                    HEAP32[$772 >> 2] = $672
                    $773 = ((($672)) + 8 | 0)
                    HEAP32[$773 >> 2] = $$0267$i$i
                    $774 = ((($672)) + 12 | 0)
                    HEAP32[$774 >> 2] = $764
                    break
                  }
                  $775 = $$0259$i$i >>> 8
                  $776 = ($775 | 0) == (0)
                  do {
                    if ($776) {
                      $$0268$i$i = 0
                    } else {
                      $777 = ($$0259$i$i >>> 0) > (16777215)
                      if ($777) {
                        $$0268$i$i = 31
                        break
                      }
                      $778 = (($775) + 1048320) | 0
                      $779 = $778 >>> 16
                      $780 = $779 & 8
                      $781 = $775 << $780
                      $782 = (($781) + 520192) | 0
                      $783 = $782 >>> 16
                      $784 = $783 & 4
                      $785 = $784 | $780
                      $786 = $781 << $784
                      $787 = (($786) + 245760) | 0
                      $788 = $787 >>> 16
                      $789 = $788 & 2
                      $790 = $785 | $789
                      $791 = (14 - ($790)) | 0
                      $792 = $786 << $789
                      $793 = $792 >>> 15
                      $794 = (($791) + ($793)) | 0
                      $795 = $794 << 1
                      $796 = (($794) + 7) | 0
                      $797 = $$0259$i$i >>> $796
                      $798 = $797 & 1
                      $799 = $798 | $795
                      $$0268$i$i = $799
                    }
                  } while (0)
                  $800 = (1536 + ($$0268$i$i << 2) | 0)
                  $801 = ((($672)) + 28 | 0)
                  HEAP32[$801 >> 2] = $$0268$i$i
                  $802 = ((($672)) + 16 | 0)
                  $803 = ((($802)) + 4 | 0)
                  HEAP32[$803 >> 2] = 0
                  HEAP32[$802 >> 2] = 0
                  $804 = HEAP32[(1236) >> 2] | 0
                  $805 = 1 << $$0268$i$i
                  $806 = $804 & $805
                  $807 = ($806 | 0) == (0)
                  if ($807) {
                    $808 = $804 | $805
                    HEAP32[(1236) >> 2] = $808
                    HEAP32[$800 >> 2] = $672
                    $809 = ((($672)) + 24 | 0)
                    HEAP32[$809 >> 2] = $800
                    $810 = ((($672)) + 12 | 0)
                    HEAP32[$810 >> 2] = $672
                    $811 = ((($672)) + 8 | 0)
                    HEAP32[$811 >> 2] = $672
                    break
                  }
                  $812 = HEAP32[$800 >> 2] | 0
                  $813 = ((($812)) + 4 | 0)
                  $814 = HEAP32[$813 >> 2] | 0
                  $815 = $814 & -8
                  $816 = ($815 | 0) == ($$0259$i$i | 0)
                  L291: do {
                    if ($816) {
                      $$0261$lcssa$i$i = $812
                    } else {
                      $817 = ($$0268$i$i | 0) == (31)
                      $818 = $$0268$i$i >>> 1
                      $819 = (25 - ($818)) | 0
                      $820 = $817 ? 0 : $819
                      $821 = $$0259$i$i << $820
                      $$02604$i$i = $821; $$02613$i$i = $812
                      while (1) {
                        $828 = $$02604$i$i >>> 31
                        $829 = (((($$02613$i$i)) + 16 | 0) + ($828 << 2) | 0)
                        $824 = HEAP32[$829 >> 2] | 0
                        $830 = ($824 | 0) == (0 | 0)
                        if ($830) {
                          break
                        }
                        $822 = $$02604$i$i << 1
                        $823 = ((($824)) + 4 | 0)
                        $825 = HEAP32[$823 >> 2] | 0
                        $826 = $825 & -8
                        $827 = ($826 | 0) == ($$0259$i$i | 0)
                        if ($827) {
                          $$0261$lcssa$i$i = $824
                          break L291
                        } else {
                          $$02604$i$i = $822; $$02613$i$i = $824
                        }
                      }
                      HEAP32[$829 >> 2] = $672
                      $831 = ((($672)) + 24 | 0)
                      HEAP32[$831 >> 2] = $$02613$i$i
                      $832 = ((($672)) + 12 | 0)
                      HEAP32[$832 >> 2] = $672
                      $833 = ((($672)) + 8 | 0)
                      HEAP32[$833 >> 2] = $672
                      break L238
                    }
                  } while (0)
                  $834 = ((($$0261$lcssa$i$i)) + 8 | 0)
                  $835 = HEAP32[$834 >> 2] | 0
                  $836 = ((($835)) + 12 | 0)
                  HEAP32[$836 >> 2] = $672
                  HEAP32[$834 >> 2] = $672
                  $837 = ((($672)) + 8 | 0)
                  HEAP32[$837 >> 2] = $835
                  $838 = ((($672)) + 12 | 0)
                  HEAP32[$838 >> 2] = $$0261$lcssa$i$i
                  $839 = ((($672)) + 24 | 0)
                  HEAP32[$839 >> 2] = 0
                }
              } while (0)
              $968 = ((($660)) + 8 | 0)
              $$0 = $968
              STACKTOP = sp; return ($$0 | 0)
            }
          }
          $$0$i$i$i = (1680)
          while (1) {
            $840 = HEAP32[$$0$i$i$i >> 2] | 0
            $841 = ($840 >>> 0) > ($585 >>> 0)
            if (!($841)) {
              $842 = ((($$0$i$i$i)) + 4 | 0)
              $843 = HEAP32[$842 >> 2] | 0
              $844 = (($840) + ($843) | 0)
              $845 = ($844 >>> 0) > ($585 >>> 0)
              if ($845) {
                break
              }
            }
            $846 = ((($$0$i$i$i)) + 8 | 0)
            $847 = HEAP32[$846 >> 2] | 0
            $$0$i$i$i = $847
          }
          $848 = ((($844)) + -47 | 0)
          $849 = ((($848)) + 8 | 0)
          $850 = $849
          $851 = $850 & 7
          $852 = ($851 | 0) == (0)
          $853 = (0 - ($850)) | 0
          $854 = $853 & 7
          $855 = $852 ? 0 : $854
          $856 = (($848) + ($855) | 0)
          $857 = ((($585)) + 16 | 0)
          $858 = ($856 >>> 0) < ($857 >>> 0)
          $859 = $858 ? $585 : $856
          $860 = ((($859)) + 8 | 0)
          $861 = ((($859)) + 24 | 0)
          $862 = (($$723947$i) + -40) | 0
          $863 = ((($$748$i)) + 8 | 0)
          $864 = $863
          $865 = $864 & 7
          $866 = ($865 | 0) == (0)
          $867 = (0 - ($864)) | 0
          $868 = $867 & 7
          $869 = $866 ? 0 : $868
          $870 = (($$748$i) + ($869) | 0)
          $871 = (($862) - ($869)) | 0
          HEAP32[(1256) >> 2] = $870
          HEAP32[(1244) >> 2] = $871
          $872 = $871 | 1
          $873 = ((($870)) + 4 | 0)
          HEAP32[$873 >> 2] = $872
          $874 = (($$748$i) + ($862) | 0)
          $875 = ((($874)) + 4 | 0)
          HEAP32[$875 >> 2] = 40
          $876 = HEAP32[(1720) >> 2] | 0
          HEAP32[(1260) >> 2] = $876
          $877 = ((($859)) + 4 | 0)
          HEAP32[$877 >> 2] = 27
          HEAP32[$860 >> 2] = HEAP32[(1680) >> 2] | 0; HEAP32[$860 + 4 >> 2] = HEAP32[(1680) + 4 >> 2] | 0; HEAP32[$860 + 8 >> 2] = HEAP32[(1680) + 8 >> 2] | 0; HEAP32[$860 + 12 >> 2] = HEAP32[(1680) + 12 >> 2] | 0
          HEAP32[(1680) >> 2] = $$748$i
          HEAP32[(1684) >> 2] = $$723947$i
          HEAP32[(1692) >> 2] = 0
          HEAP32[(1688) >> 2] = $860
          $879 = $861
          while (1) {
            $878 = ((($879)) + 4 | 0)
            HEAP32[$878 >> 2] = 7
            $880 = ((($879)) + 8 | 0)
            $881 = ($880 >>> 0) < ($844 >>> 0)
            if ($881) {
              $879 = $878
            } else {
              break
            }
          }
          $882 = ($859 | 0) == ($585 | 0)
          if (!($882)) {
            $883 = $859
            $884 = $585
            $885 = (($883) - ($884)) | 0
            $886 = HEAP32[$877 >> 2] | 0
            $887 = $886 & -2
            HEAP32[$877 >> 2] = $887
            $888 = $885 | 1
            $889 = ((($585)) + 4 | 0)
            HEAP32[$889 >> 2] = $888
            HEAP32[$859 >> 2] = $885
            $890 = $885 >>> 3
            $891 = ($885 >>> 0) < (256)
            if ($891) {
              $892 = $890 << 1
              $893 = (1272 + ($892 << 2) | 0)
              $894 = HEAP32[308] | 0
              $895 = 1 << $890
              $896 = $894 & $895
              $897 = ($896 | 0) == (0)
              if ($897) {
                $898 = $894 | $895
                HEAP32[308] = $898
                $$pre$i$i = ((($893)) + 8 | 0)
                $$0206$i$i = $893; $$pre$phi$i$iZ2D = $$pre$i$i
              } else {
                $899 = ((($893)) + 8 | 0)
                $900 = HEAP32[$899 >> 2] | 0
                $$0206$i$i = $900; $$pre$phi$i$iZ2D = $899
              }
              HEAP32[$$pre$phi$i$iZ2D >> 2] = $585
              $901 = ((($$0206$i$i)) + 12 | 0)
              HEAP32[$901 >> 2] = $585
              $902 = ((($585)) + 8 | 0)
              HEAP32[$902 >> 2] = $$0206$i$i
              $903 = ((($585)) + 12 | 0)
              HEAP32[$903 >> 2] = $893
              break
            }
            $904 = $885 >>> 8
            $905 = ($904 | 0) == (0)
            if ($905) {
              $$0207$i$i = 0
            } else {
              $906 = ($885 >>> 0) > (16777215)
              if ($906) {
                $$0207$i$i = 31
              } else {
                $907 = (($904) + 1048320) | 0
                $908 = $907 >>> 16
                $909 = $908 & 8
                $910 = $904 << $909
                $911 = (($910) + 520192) | 0
                $912 = $911 >>> 16
                $913 = $912 & 4
                $914 = $913 | $909
                $915 = $910 << $913
                $916 = (($915) + 245760) | 0
                $917 = $916 >>> 16
                $918 = $917 & 2
                $919 = $914 | $918
                $920 = (14 - ($919)) | 0
                $921 = $915 << $918
                $922 = $921 >>> 15
                $923 = (($920) + ($922)) | 0
                $924 = $923 << 1
                $925 = (($923) + 7) | 0
                $926 = $885 >>> $925
                $927 = $926 & 1
                $928 = $927 | $924
                $$0207$i$i = $928
              }
            }
            $929 = (1536 + ($$0207$i$i << 2) | 0)
            $930 = ((($585)) + 28 | 0)
            HEAP32[$930 >> 2] = $$0207$i$i
            $931 = ((($585)) + 20 | 0)
            HEAP32[$931 >> 2] = 0
            HEAP32[$857 >> 2] = 0
            $932 = HEAP32[(1236) >> 2] | 0
            $933 = 1 << $$0207$i$i
            $934 = $932 & $933
            $935 = ($934 | 0) == (0)
            if ($935) {
              $936 = $932 | $933
              HEAP32[(1236) >> 2] = $936
              HEAP32[$929 >> 2] = $585
              $937 = ((($585)) + 24 | 0)
              HEAP32[$937 >> 2] = $929
              $938 = ((($585)) + 12 | 0)
              HEAP32[$938 >> 2] = $585
              $939 = ((($585)) + 8 | 0)
              HEAP32[$939 >> 2] = $585
              break
            }
            $940 = HEAP32[$929 >> 2] | 0
            $941 = ((($940)) + 4 | 0)
            $942 = HEAP32[$941 >> 2] | 0
            $943 = $942 & -8
            $944 = ($943 | 0) == ($885 | 0)
            L325: do {
              if ($944) {
                $$0202$lcssa$i$i = $940
              } else {
                $945 = ($$0207$i$i | 0) == (31)
                $946 = $$0207$i$i >>> 1
                $947 = (25 - ($946)) | 0
                $948 = $945 ? 0 : $947
                $949 = $885 << $948
                $$02014$i$i = $949; $$02023$i$i = $940
                while (1) {
                  $956 = $$02014$i$i >>> 31
                  $957 = (((($$02023$i$i)) + 16 | 0) + ($956 << 2) | 0)
                  $952 = HEAP32[$957 >> 2] | 0
                  $958 = ($952 | 0) == (0 | 0)
                  if ($958) {
                    break
                  }
                  $950 = $$02014$i$i << 1
                  $951 = ((($952)) + 4 | 0)
                  $953 = HEAP32[$951 >> 2] | 0
                  $954 = $953 & -8
                  $955 = ($954 | 0) == ($885 | 0)
                  if ($955) {
                    $$0202$lcssa$i$i = $952
                    break L325
                  } else {
                    $$02014$i$i = $950; $$02023$i$i = $952
                  }
                }
                HEAP32[$957 >> 2] = $585
                $959 = ((($585)) + 24 | 0)
                HEAP32[$959 >> 2] = $$02023$i$i
                $960 = ((($585)) + 12 | 0)
                HEAP32[$960 >> 2] = $585
                $961 = ((($585)) + 8 | 0)
                HEAP32[$961 >> 2] = $585
                break L215
              }
            } while (0)
            $962 = ((($$0202$lcssa$i$i)) + 8 | 0)
            $963 = HEAP32[$962 >> 2] | 0
            $964 = ((($963)) + 12 | 0)
            HEAP32[$964 >> 2] = $585
            HEAP32[$962 >> 2] = $585
            $965 = ((($585)) + 8 | 0)
            HEAP32[$965 >> 2] = $963
            $966 = ((($585)) + 12 | 0)
            HEAP32[$966 >> 2] = $$0202$lcssa$i$i
            $967 = ((($585)) + 24 | 0)
            HEAP32[$967 >> 2] = 0
          }
        }
      } while (0)
      $969 = HEAP32[(1244) >> 2] | 0
      $970 = ($969 >>> 0) > ($$0192 >>> 0)
      if ($970) {
        $971 = (($969) - ($$0192)) | 0
        HEAP32[(1244) >> 2] = $971
        $972 = HEAP32[(1256) >> 2] | 0
        $973 = (($972) + ($$0192) | 0)
        HEAP32[(1256) >> 2] = $973
        $974 = $971 | 1
        $975 = ((($973)) + 4 | 0)
        HEAP32[$975 >> 2] = $974
        $976 = $$0192 | 3
        $977 = ((($972)) + 4 | 0)
        HEAP32[$977 >> 2] = $976
        $978 = ((($972)) + 8 | 0)
        $$0 = $978
        STACKTOP = sp; return ($$0 | 0)
      }
    }
    $979 = (___errno_location() | 0)
    HEAP32[$979 >> 2] = 48
    $$0 = 0
    STACKTOP = sp; return ($$0 | 0)
  }
  function _free ($0) {
    $0 = $0 | 0
    var $$0194$i = 0; var $$0194$in$i = 0; var $$0346381 = 0; var $$0347$lcssa = 0; var $$0347380 = 0; var $$0359 = 0; var $$0366 = 0; var $$1 = 0; var $$1345 = 0; var $$1350 = 0; var $$1350$be = 0; var $$1350$ph = 0; var $$1353 = 0; var $$1353$be = 0; var $$1353$ph = 0; var $$1361 = 0; var $$1361$be = 0; var $$1361$ph = 0; var $$1365 = 0; var $$1365$be = 0
    var $$1365$ph = 0; var $$2 = 0; var $$3 = 0; var $$3363 = 0; var $$pre = 0; var $$pre$phiZ2D = 0; var $$sink = 0; var $$sink395 = 0; var $1 = 0; var $10 = 0; var $100 = 0; var $101 = 0; var $102 = 0; var $103 = 0; var $104 = 0; var $105 = 0; var $106 = 0; var $107 = 0; var $108 = 0; var $109 = 0
    var $11 = 0; var $110 = 0; var $111 = 0; var $112 = 0; var $113 = 0; var $114 = 0; var $115 = 0; var $116 = 0; var $117 = 0; var $118 = 0; var $119 = 0; var $12 = 0; var $120 = 0; var $121 = 0; var $122 = 0; var $123 = 0; var $124 = 0; var $125 = 0; var $126 = 0; var $127 = 0
    var $128 = 0; var $129 = 0; var $13 = 0; var $130 = 0; var $131 = 0; var $132 = 0; var $133 = 0; var $134 = 0; var $135 = 0; var $136 = 0; var $137 = 0; var $138 = 0; var $139 = 0; var $14 = 0; var $140 = 0; var $141 = 0; var $142 = 0; var $143 = 0; var $144 = 0; var $145 = 0
    var $146 = 0; var $147 = 0; var $148 = 0; var $149 = 0; var $15 = 0; var $150 = 0; var $151 = 0; var $152 = 0; var $153 = 0; var $154 = 0; var $155 = 0; var $156 = 0; var $157 = 0; var $158 = 0; var $159 = 0; var $16 = 0; var $160 = 0; var $161 = 0; var $162 = 0; var $163 = 0
    var $164 = 0; var $165 = 0; var $166 = 0; var $167 = 0; var $168 = 0; var $169 = 0; var $17 = 0; var $170 = 0; var $171 = 0; var $172 = 0; var $173 = 0; var $174 = 0; var $175 = 0; var $176 = 0; var $177 = 0; var $178 = 0; var $179 = 0; var $18 = 0; var $180 = 0; var $181 = 0
    var $182 = 0; var $183 = 0; var $184 = 0; var $185 = 0; var $186 = 0; var $187 = 0; var $188 = 0; var $189 = 0; var $19 = 0; var $190 = 0; var $191 = 0; var $192 = 0; var $193 = 0; var $194 = 0; var $195 = 0; var $196 = 0; var $197 = 0; var $198 = 0; var $199 = 0; var $2 = 0
    var $20 = 0; var $200 = 0; var $201 = 0; var $202 = 0; var $203 = 0; var $204 = 0; var $205 = 0; var $206 = 0; var $207 = 0; var $208 = 0; var $209 = 0; var $21 = 0; var $210 = 0; var $211 = 0; var $212 = 0; var $213 = 0; var $214 = 0; var $215 = 0; var $216 = 0; var $217 = 0
    var $218 = 0; var $219 = 0; var $22 = 0; var $220 = 0; var $221 = 0; var $222 = 0; var $223 = 0; var $224 = 0; var $225 = 0; var $226 = 0; var $227 = 0; var $228 = 0; var $229 = 0; var $23 = 0; var $230 = 0; var $231 = 0; var $232 = 0; var $233 = 0; var $234 = 0; var $235 = 0
    var $236 = 0; var $237 = 0; var $238 = 0; var $239 = 0; var $24 = 0; var $240 = 0; var $241 = 0; var $242 = 0; var $243 = 0; var $244 = 0; var $245 = 0; var $246 = 0; var $247 = 0; var $248 = 0; var $249 = 0; var $25 = 0; var $250 = 0; var $251 = 0; var $252 = 0; var $253 = 0
    var $254 = 0; var $255 = 0; var $256 = 0; var $257 = 0; var $258 = 0; var $259 = 0; var $26 = 0; var $260 = 0; var $261 = 0; var $262 = 0; var $263 = 0; var $264 = 0; var $27 = 0; var $28 = 0; var $29 = 0; var $3 = 0; var $30 = 0; var $31 = 0; var $32 = 0; var $33 = 0
    var $34 = 0; var $35 = 0; var $36 = 0; var $37 = 0; var $38 = 0; var $39 = 0; var $4 = 0; var $40 = 0; var $41 = 0; var $42 = 0; var $43 = 0; var $44 = 0; var $45 = 0; var $46 = 0; var $47 = 0; var $48 = 0; var $49 = 0; var $5 = 0; var $50 = 0; var $51 = 0
    var $52 = 0; var $53 = 0; var $54 = 0; var $55 = 0; var $56 = 0; var $57 = 0; var $58 = 0; var $59 = 0; var $6 = 0; var $60 = 0; var $61 = 0; var $62 = 0; var $63 = 0; var $64 = 0; var $65 = 0; var $66 = 0; var $67 = 0; var $68 = 0; var $69 = 0; var $7 = 0
    var $70 = 0; var $71 = 0; var $72 = 0; var $73 = 0; var $74 = 0; var $75 = 0; var $76 = 0; var $77 = 0; var $78 = 0; var $79 = 0; var $8 = 0; var $80 = 0; var $81 = 0; var $82 = 0; var $83 = 0; var $84 = 0; var $85 = 0; var $86 = 0; var $87 = 0; var $88 = 0
    var $89 = 0; var $9 = 0; var $90 = 0; var $91 = 0; var $92 = 0; var $93 = 0; var $94 = 0; var $95 = 0; var $96 = 0; var $97 = 0; var $98 = 0; var $99 = 0; var $cond371 = 0; var $cond372 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    $1 = ($0 | 0) == (0 | 0)
    if ($1) {
      return
    }
    $2 = ((($0)) + -8 | 0)
    $3 = HEAP32[(1248) >> 2] | 0
    $4 = ((($0)) + -4 | 0)
    $5 = HEAP32[$4 >> 2] | 0
    $6 = $5 & -8
    $7 = (($2) + ($6) | 0)
    $8 = $5 & 1
    $9 = ($8 | 0) == (0)
    do {
      if ($9) {
        $10 = HEAP32[$2 >> 2] | 0
        $11 = $5 & 3
        $12 = ($11 | 0) == (0)
        if ($12) {
          return
        }
        $13 = (0 - ($10)) | 0
        $14 = (($2) + ($13) | 0)
        $15 = (($10) + ($6)) | 0
        $16 = ($14 >>> 0) < ($3 >>> 0)
        if ($16) {
          return
        }
        $17 = HEAP32[(1252) >> 2] | 0
        $18 = ($17 | 0) == ($14 | 0)
        if ($18) {
          $79 = ((($7)) + 4 | 0)
          $80 = HEAP32[$79 >> 2] | 0
          $81 = $80 & 3
          $82 = ($81 | 0) == (3)
          if (!($82)) {
            $$1 = $14; $$1345 = $15; $88 = $14
            break
          }
          $83 = (($14) + ($15) | 0)
          $84 = ((($14)) + 4 | 0)
          $85 = $15 | 1
          $86 = $80 & -2
          HEAP32[(1240) >> 2] = $15
          HEAP32[$79 >> 2] = $86
          HEAP32[$84 >> 2] = $85
          HEAP32[$83 >> 2] = $15
          return
        }
        $19 = $10 >>> 3
        $20 = ($10 >>> 0) < (256)
        if ($20) {
          $21 = ((($14)) + 8 | 0)
          $22 = HEAP32[$21 >> 2] | 0
          $23 = ((($14)) + 12 | 0)
          $24 = HEAP32[$23 >> 2] | 0
          $25 = ($24 | 0) == ($22 | 0)
          if ($25) {
            $26 = 1 << $19
            $27 = $26 ^ -1
            $28 = HEAP32[308] | 0
            $29 = $28 & $27
            HEAP32[308] = $29
            $$1 = $14; $$1345 = $15; $88 = $14
            break
          } else {
            $30 = ((($22)) + 12 | 0)
            HEAP32[$30 >> 2] = $24
            $31 = ((($24)) + 8 | 0)
            HEAP32[$31 >> 2] = $22
            $$1 = $14; $$1345 = $15; $88 = $14
            break
          }
        }
        $32 = ((($14)) + 24 | 0)
        $33 = HEAP32[$32 >> 2] | 0
        $34 = ((($14)) + 12 | 0)
        $35 = HEAP32[$34 >> 2] | 0
        $36 = ($35 | 0) == ($14 | 0)
        do {
          if ($36) {
            $41 = ((($14)) + 16 | 0)
            $42 = ((($41)) + 4 | 0)
            $43 = HEAP32[$42 >> 2] | 0
            $44 = ($43 | 0) == (0 | 0)
            if ($44) {
              $45 = HEAP32[$41 >> 2] | 0
              $46 = ($45 | 0) == (0 | 0)
              if ($46) {
                $$3 = 0
                break
              } else {
                $$1350$ph = $45; $$1353$ph = $41
              }
            } else {
              $$1350$ph = $43; $$1353$ph = $42
            }
            $$1350 = $$1350$ph; $$1353 = $$1353$ph
            while (1) {
              $47 = ((($$1350)) + 20 | 0)
              $48 = HEAP32[$47 >> 2] | 0
              $49 = ($48 | 0) == (0 | 0)
              if ($49) {
                $50 = ((($$1350)) + 16 | 0)
                $51 = HEAP32[$50 >> 2] | 0
                $52 = ($51 | 0) == (0 | 0)
                if ($52) {
                  break
                } else {
                  $$1350$be = $51; $$1353$be = $50
                }
              } else {
                $$1350$be = $48; $$1353$be = $47
              }
              $$1350 = $$1350$be; $$1353 = $$1353$be
            }
            HEAP32[$$1353 >> 2] = 0
            $$3 = $$1350
          } else {
            $37 = ((($14)) + 8 | 0)
            $38 = HEAP32[$37 >> 2] | 0
            $39 = ((($38)) + 12 | 0)
            HEAP32[$39 >> 2] = $35
            $40 = ((($35)) + 8 | 0)
            HEAP32[$40 >> 2] = $38
            $$3 = $35
          }
        } while (0)
        $53 = ($33 | 0) == (0 | 0)
        if ($53) {
          $$1 = $14; $$1345 = $15; $88 = $14
        } else {
          $54 = ((($14)) + 28 | 0)
          $55 = HEAP32[$54 >> 2] | 0
          $56 = (1536 + ($55 << 2) | 0)
          $57 = HEAP32[$56 >> 2] | 0
          $58 = ($57 | 0) == ($14 | 0)
          if ($58) {
            HEAP32[$56 >> 2] = $$3
            $cond371 = ($$3 | 0) == (0 | 0)
            if ($cond371) {
              $59 = 1 << $55
              $60 = $59 ^ -1
              $61 = HEAP32[(1236) >> 2] | 0
              $62 = $61 & $60
              HEAP32[(1236) >> 2] = $62
              $$1 = $14; $$1345 = $15; $88 = $14
              break
            }
          } else {
            $63 = ((($33)) + 16 | 0)
            $64 = HEAP32[$63 >> 2] | 0
            $65 = ($64 | 0) == ($14 | 0)
            $66 = ((($33)) + 20 | 0)
            $$sink = $65 ? $63 : $66
            HEAP32[$$sink >> 2] = $$3
            $67 = ($$3 | 0) == (0 | 0)
            if ($67) {
              $$1 = $14; $$1345 = $15; $88 = $14
              break
            }
          }
          $68 = ((($$3)) + 24 | 0)
          HEAP32[$68 >> 2] = $33
          $69 = ((($14)) + 16 | 0)
          $70 = HEAP32[$69 >> 2] | 0
          $71 = ($70 | 0) == (0 | 0)
          if (!($71)) {
            $72 = ((($$3)) + 16 | 0)
            HEAP32[$72 >> 2] = $70
            $73 = ((($70)) + 24 | 0)
            HEAP32[$73 >> 2] = $$3
          }
          $74 = ((($69)) + 4 | 0)
          $75 = HEAP32[$74 >> 2] | 0
          $76 = ($75 | 0) == (0 | 0)
          if ($76) {
            $$1 = $14; $$1345 = $15; $88 = $14
          } else {
            $77 = ((($$3)) + 20 | 0)
            HEAP32[$77 >> 2] = $75
            $78 = ((($75)) + 24 | 0)
            HEAP32[$78 >> 2] = $$3
            $$1 = $14; $$1345 = $15; $88 = $14
          }
        }
      } else {
        $$1 = $2; $$1345 = $6; $88 = $2
      }
    } while (0)
    $87 = ($88 >>> 0) < ($7 >>> 0)
    if (!($87)) {
      return
    }
    $89 = ((($7)) + 4 | 0)
    $90 = HEAP32[$89 >> 2] | 0
    $91 = $90 & 1
    $92 = ($91 | 0) == (0)
    if ($92) {
      return
    }
    $93 = $90 & 2
    $94 = ($93 | 0) == (0)
    if ($94) {
      $95 = HEAP32[(1256) >> 2] | 0
      $96 = ($95 | 0) == ($7 | 0)
      if ($96) {
        $97 = HEAP32[(1244) >> 2] | 0
        $98 = (($97) + ($$1345)) | 0
        HEAP32[(1244) >> 2] = $98
        HEAP32[(1256) >> 2] = $$1
        $99 = $98 | 1
        $100 = ((($$1)) + 4 | 0)
        HEAP32[$100 >> 2] = $99
        $101 = HEAP32[(1252) >> 2] | 0
        $102 = ($$1 | 0) == ($101 | 0)
        if (!($102)) {
          return
        }
        HEAP32[(1252) >> 2] = 0
        HEAP32[(1240) >> 2] = 0
        return
      }
      $103 = HEAP32[(1252) >> 2] | 0
      $104 = ($103 | 0) == ($7 | 0)
      if ($104) {
        $105 = HEAP32[(1240) >> 2] | 0
        $106 = (($105) + ($$1345)) | 0
        HEAP32[(1240) >> 2] = $106
        HEAP32[(1252) >> 2] = $88
        $107 = $106 | 1
        $108 = ((($$1)) + 4 | 0)
        HEAP32[$108 >> 2] = $107
        $109 = (($88) + ($106) | 0)
        HEAP32[$109 >> 2] = $106
        return
      }
      $110 = $90 & -8
      $111 = (($110) + ($$1345)) | 0
      $112 = $90 >>> 3
      $113 = ($90 >>> 0) < (256)
      do {
        if ($113) {
          $114 = ((($7)) + 8 | 0)
          $115 = HEAP32[$114 >> 2] | 0
          $116 = ((($7)) + 12 | 0)
          $117 = HEAP32[$116 >> 2] | 0
          $118 = ($117 | 0) == ($115 | 0)
          if ($118) {
            $119 = 1 << $112
            $120 = $119 ^ -1
            $121 = HEAP32[308] | 0
            $122 = $121 & $120
            HEAP32[308] = $122
            break
          } else {
            $123 = ((($115)) + 12 | 0)
            HEAP32[$123 >> 2] = $117
            $124 = ((($117)) + 8 | 0)
            HEAP32[$124 >> 2] = $115
            break
          }
        } else {
          $125 = ((($7)) + 24 | 0)
          $126 = HEAP32[$125 >> 2] | 0
          $127 = ((($7)) + 12 | 0)
          $128 = HEAP32[$127 >> 2] | 0
          $129 = ($128 | 0) == ($7 | 0)
          do {
            if ($129) {
              $134 = ((($7)) + 16 | 0)
              $135 = ((($134)) + 4 | 0)
              $136 = HEAP32[$135 >> 2] | 0
              $137 = ($136 | 0) == (0 | 0)
              if ($137) {
                $138 = HEAP32[$134 >> 2] | 0
                $139 = ($138 | 0) == (0 | 0)
                if ($139) {
                  $$3363 = 0
                  break
                } else {
                  $$1361$ph = $138; $$1365$ph = $134
                }
              } else {
                $$1361$ph = $136; $$1365$ph = $135
              }
              $$1361 = $$1361$ph; $$1365 = $$1365$ph
              while (1) {
                $140 = ((($$1361)) + 20 | 0)
                $141 = HEAP32[$140 >> 2] | 0
                $142 = ($141 | 0) == (0 | 0)
                if ($142) {
                  $143 = ((($$1361)) + 16 | 0)
                  $144 = HEAP32[$143 >> 2] | 0
                  $145 = ($144 | 0) == (0 | 0)
                  if ($145) {
                    break
                  } else {
                    $$1361$be = $144; $$1365$be = $143
                  }
                } else {
                  $$1361$be = $141; $$1365$be = $140
                }
                $$1361 = $$1361$be; $$1365 = $$1365$be
              }
              HEAP32[$$1365 >> 2] = 0
              $$3363 = $$1361
            } else {
              $130 = ((($7)) + 8 | 0)
              $131 = HEAP32[$130 >> 2] | 0
              $132 = ((($131)) + 12 | 0)
              HEAP32[$132 >> 2] = $128
              $133 = ((($128)) + 8 | 0)
              HEAP32[$133 >> 2] = $131
              $$3363 = $128
            }
          } while (0)
          $146 = ($126 | 0) == (0 | 0)
          if (!($146)) {
            $147 = ((($7)) + 28 | 0)
            $148 = HEAP32[$147 >> 2] | 0
            $149 = (1536 + ($148 << 2) | 0)
            $150 = HEAP32[$149 >> 2] | 0
            $151 = ($150 | 0) == ($7 | 0)
            if ($151) {
              HEAP32[$149 >> 2] = $$3363
              $cond372 = ($$3363 | 0) == (0 | 0)
              if ($cond372) {
                $152 = 1 << $148
                $153 = $152 ^ -1
                $154 = HEAP32[(1236) >> 2] | 0
                $155 = $154 & $153
                HEAP32[(1236) >> 2] = $155
                break
              }
            } else {
              $156 = ((($126)) + 16 | 0)
              $157 = HEAP32[$156 >> 2] | 0
              $158 = ($157 | 0) == ($7 | 0)
              $159 = ((($126)) + 20 | 0)
              $$sink395 = $158 ? $156 : $159
              HEAP32[$$sink395 >> 2] = $$3363
              $160 = ($$3363 | 0) == (0 | 0)
              if ($160) {
                break
              }
            }
            $161 = ((($$3363)) + 24 | 0)
            HEAP32[$161 >> 2] = $126
            $162 = ((($7)) + 16 | 0)
            $163 = HEAP32[$162 >> 2] | 0
            $164 = ($163 | 0) == (0 | 0)
            if (!($164)) {
              $165 = ((($$3363)) + 16 | 0)
              HEAP32[$165 >> 2] = $163
              $166 = ((($163)) + 24 | 0)
              HEAP32[$166 >> 2] = $$3363
            }
            $167 = ((($162)) + 4 | 0)
            $168 = HEAP32[$167 >> 2] | 0
            $169 = ($168 | 0) == (0 | 0)
            if (!($169)) {
              $170 = ((($$3363)) + 20 | 0)
              HEAP32[$170 >> 2] = $168
              $171 = ((($168)) + 24 | 0)
              HEAP32[$171 >> 2] = $$3363
            }
          }
        }
      } while (0)
      $172 = $111 | 1
      $173 = ((($$1)) + 4 | 0)
      HEAP32[$173 >> 2] = $172
      $174 = (($88) + ($111) | 0)
      HEAP32[$174 >> 2] = $111
      $175 = HEAP32[(1252) >> 2] | 0
      $176 = ($$1 | 0) == ($175 | 0)
      if ($176) {
        HEAP32[(1240) >> 2] = $111
        return
      } else {
        $$2 = $111
      }
    } else {
      $177 = $90 & -2
      HEAP32[$89 >> 2] = $177
      $178 = $$1345 | 1
      $179 = ((($$1)) + 4 | 0)
      HEAP32[$179 >> 2] = $178
      $180 = (($88) + ($$1345) | 0)
      HEAP32[$180 >> 2] = $$1345
      $$2 = $$1345
    }
    $181 = $$2 >>> 3
    $182 = ($$2 >>> 0) < (256)
    if ($182) {
      $183 = $181 << 1
      $184 = (1272 + ($183 << 2) | 0)
      $185 = HEAP32[308] | 0
      $186 = 1 << $181
      $187 = $185 & $186
      $188 = ($187 | 0) == (0)
      if ($188) {
        $189 = $185 | $186
        HEAP32[308] = $189
        $$pre = ((($184)) + 8 | 0)
        $$0366 = $184; $$pre$phiZ2D = $$pre
      } else {
        $190 = ((($184)) + 8 | 0)
        $191 = HEAP32[$190 >> 2] | 0
        $$0366 = $191; $$pre$phiZ2D = $190
      }
      HEAP32[$$pre$phiZ2D >> 2] = $$1
      $192 = ((($$0366)) + 12 | 0)
      HEAP32[$192 >> 2] = $$1
      $193 = ((($$1)) + 8 | 0)
      HEAP32[$193 >> 2] = $$0366
      $194 = ((($$1)) + 12 | 0)
      HEAP32[$194 >> 2] = $184
      return
    }
    $195 = $$2 >>> 8
    $196 = ($195 | 0) == (0)
    if ($196) {
      $$0359 = 0
    } else {
      $197 = ($$2 >>> 0) > (16777215)
      if ($197) {
        $$0359 = 31
      } else {
        $198 = (($195) + 1048320) | 0
        $199 = $198 >>> 16
        $200 = $199 & 8
        $201 = $195 << $200
        $202 = (($201) + 520192) | 0
        $203 = $202 >>> 16
        $204 = $203 & 4
        $205 = $204 | $200
        $206 = $201 << $204
        $207 = (($206) + 245760) | 0
        $208 = $207 >>> 16
        $209 = $208 & 2
        $210 = $205 | $209
        $211 = (14 - ($210)) | 0
        $212 = $206 << $209
        $213 = $212 >>> 15
        $214 = (($211) + ($213)) | 0
        $215 = $214 << 1
        $216 = (($214) + 7) | 0
        $217 = $$2 >>> $216
        $218 = $217 & 1
        $219 = $218 | $215
        $$0359 = $219
      }
    }
    $220 = (1536 + ($$0359 << 2) | 0)
    $221 = ((($$1)) + 28 | 0)
    HEAP32[$221 >> 2] = $$0359
    $222 = ((($$1)) + 16 | 0)
    $223 = ((($$1)) + 20 | 0)
    HEAP32[$223 >> 2] = 0
    HEAP32[$222 >> 2] = 0
    $224 = HEAP32[(1236) >> 2] | 0
    $225 = 1 << $$0359
    $226 = $224 & $225
    $227 = ($226 | 0) == (0)
    L112: do {
      if ($227) {
        $228 = $224 | $225
        HEAP32[(1236) >> 2] = $228
        HEAP32[$220 >> 2] = $$1
        $229 = ((($$1)) + 24 | 0)
        HEAP32[$229 >> 2] = $220
        $230 = ((($$1)) + 12 | 0)
        HEAP32[$230 >> 2] = $$1
        $231 = ((($$1)) + 8 | 0)
        HEAP32[$231 >> 2] = $$1
      } else {
        $232 = HEAP32[$220 >> 2] | 0
        $233 = ((($232)) + 4 | 0)
        $234 = HEAP32[$233 >> 2] | 0
        $235 = $234 & -8
        $236 = ($235 | 0) == ($$2 | 0)
        L115: do {
          if ($236) {
            $$0347$lcssa = $232
          } else {
            $237 = ($$0359 | 0) == (31)
            $238 = $$0359 >>> 1
            $239 = (25 - ($238)) | 0
            $240 = $237 ? 0 : $239
            $241 = $$2 << $240
            $$0346381 = $241; $$0347380 = $232
            while (1) {
              $248 = $$0346381 >>> 31
              $249 = (((($$0347380)) + 16 | 0) + ($248 << 2) | 0)
              $244 = HEAP32[$249 >> 2] | 0
              $250 = ($244 | 0) == (0 | 0)
              if ($250) {
                break
              }
              $242 = $$0346381 << 1
              $243 = ((($244)) + 4 | 0)
              $245 = HEAP32[$243 >> 2] | 0
              $246 = $245 & -8
              $247 = ($246 | 0) == ($$2 | 0)
              if ($247) {
                $$0347$lcssa = $244
                break L115
              } else {
                $$0346381 = $242; $$0347380 = $244
              }
            }
            HEAP32[$249 >> 2] = $$1
            $251 = ((($$1)) + 24 | 0)
            HEAP32[$251 >> 2] = $$0347380
            $252 = ((($$1)) + 12 | 0)
            HEAP32[$252 >> 2] = $$1
            $253 = ((($$1)) + 8 | 0)
            HEAP32[$253 >> 2] = $$1
            break L112
          }
        } while (0)
        $254 = ((($$0347$lcssa)) + 8 | 0)
        $255 = HEAP32[$254 >> 2] | 0
        $256 = ((($255)) + 12 | 0)
        HEAP32[$256 >> 2] = $$1
        HEAP32[$254 >> 2] = $$1
        $257 = ((($$1)) + 8 | 0)
        HEAP32[$257 >> 2] = $255
        $258 = ((($$1)) + 12 | 0)
        HEAP32[$258 >> 2] = $$0347$lcssa
        $259 = ((($$1)) + 24 | 0)
        HEAP32[$259 >> 2] = 0
      }
    } while (0)
    $260 = HEAP32[(1264) >> 2] | 0
    $261 = (($260) + -1) | 0
    HEAP32[(1264) >> 2] = $261
    $262 = ($261 | 0) == (0)
    if (!($262)) {
      return
    }
    $$0194$in$i = (1688)
    while (1) {
      $$0194$i = HEAP32[$$0194$in$i >> 2] | 0
      $263 = ($$0194$i | 0) == (0 | 0)
      $264 = ((($$0194$i)) + 8 | 0)
      if ($263) {
        break
      } else {
        $$0194$in$i = $264
      }
    }
    HEAP32[(1264) >> 2] = -1
  }
  function _sbrk ($0) {
    $0 = $0 | 0
    var $$2 = 0; var $1 = 0; var $10 = 0; var $11 = 0; var $2 = 0; var $3 = 0; var $4 = 0; var $5 = 0; var $6 = 0; var $7 = 0; var $8 = 0; var $9 = 0; var label = 0; var sp = 0
    sp = STACKTOP
    $1 = (_emscripten_get_sbrk_ptr() | 0)
    $2 = HEAP32[$1 >> 2] | 0
    $3 = (($2) + ($0)) | 0
    $4 = ($3 | 0) < (0)
    if ($4) {
      $5 = (___errno_location() | 0)
      HEAP32[$5 >> 2] = 48
      $$2 = (-1)
      return ($$2 | 0)
    }
    $6 = (_emscripten_get_heap_size() | 0)
    $7 = ($3 >>> 0) > ($6 >>> 0)
    if ($7) {
      $8 = (_emscripten_resize_heap(($3 | 0)) | 0)
      $9 = ($8 | 0) == (0)
      if ($9) {
        $10 = (___errno_location() | 0)
        HEAP32[$10 >> 2] = 48
        $$2 = (-1)
        return ($$2 | 0)
      }
    }
    HEAP32[$1 >> 2] = $3
    $11 = $2
    $$2 = $11
    return ($$2 | 0)
  }
  function _emscripten_get_sbrk_ptr () {
    return 1744
  }
  function _memcpy (dest, src, num) {
    dest = dest | 0; src = src | 0; num = num | 0
    var ret = 0
    var aligned_dest_end = 0
    var block_aligned_dest_end = 0
    var dest_end = 0
    // Test against a benchmarked cutoff limit for when HEAPU8.set() becomes faster to use.
    if ((num | 0) >= 8192) {
      _emscripten_memcpy_big(dest | 0, src | 0, num | 0) | 0
      return dest | 0
    }

    ret = dest | 0
    dest_end = (dest + num) | 0
    if ((dest & 3) == (src & 3)) {
      // The initial unaligned < 4-byte front.
      while (dest & 3) {
        if ((num | 0) == 0) return ret | 0
        HEAP8[((dest) >> 0)] = ((HEAP8[((src) >> 0)]) | 0)
        dest = (dest + 1) | 0
        src = (src + 1) | 0
        num = (num - 1) | 0
      }
      aligned_dest_end = (dest_end & -4) | 0
      block_aligned_dest_end = (aligned_dest_end - 64) | 0
      while ((dest | 0) <= (block_aligned_dest_end | 0)) {
        HEAP32[((dest) >> 2)] = ((HEAP32[((src) >> 2)]) | 0)
        HEAP32[(((dest) + (4)) >> 2)] = ((HEAP32[(((src) + (4)) >> 2)]) | 0)
        HEAP32[(((dest) + (8)) >> 2)] = ((HEAP32[(((src) + (8)) >> 2)]) | 0)
        HEAP32[(((dest) + (12)) >> 2)] = ((HEAP32[(((src) + (12)) >> 2)]) | 0)
        HEAP32[(((dest) + (16)) >> 2)] = ((HEAP32[(((src) + (16)) >> 2)]) | 0)
        HEAP32[(((dest) + (20)) >> 2)] = ((HEAP32[(((src) + (20)) >> 2)]) | 0)
        HEAP32[(((dest) + (24)) >> 2)] = ((HEAP32[(((src) + (24)) >> 2)]) | 0)
        HEAP32[(((dest) + (28)) >> 2)] = ((HEAP32[(((src) + (28)) >> 2)]) | 0)
        HEAP32[(((dest) + (32)) >> 2)] = ((HEAP32[(((src) + (32)) >> 2)]) | 0)
        HEAP32[(((dest) + (36)) >> 2)] = ((HEAP32[(((src) + (36)) >> 2)]) | 0)
        HEAP32[(((dest) + (40)) >> 2)] = ((HEAP32[(((src) + (40)) >> 2)]) | 0)
        HEAP32[(((dest) + (44)) >> 2)] = ((HEAP32[(((src) + (44)) >> 2)]) | 0)
        HEAP32[(((dest) + (48)) >> 2)] = ((HEAP32[(((src) + (48)) >> 2)]) | 0)
        HEAP32[(((dest) + (52)) >> 2)] = ((HEAP32[(((src) + (52)) >> 2)]) | 0)
        HEAP32[(((dest) + (56)) >> 2)] = ((HEAP32[(((src) + (56)) >> 2)]) | 0)
        HEAP32[(((dest) + (60)) >> 2)] = ((HEAP32[(((src) + (60)) >> 2)]) | 0)
        dest = (dest + 64) | 0
        src = (src + 64) | 0
      }
      while ((dest | 0) < (aligned_dest_end | 0)) {
        HEAP32[((dest) >> 2)] = ((HEAP32[((src) >> 2)]) | 0)
        dest = (dest + 4) | 0
        src = (src + 4) | 0
      }
    } else {
      // In the unaligned copy case, unroll a bit as well.
      aligned_dest_end = (dest_end - 4) | 0
      while ((dest | 0) < (aligned_dest_end | 0)) {
        HEAP8[((dest) >> 0)] = ((HEAP8[((src) >> 0)]) | 0)
        HEAP8[(((dest) + (1)) >> 0)] = ((HEAP8[(((src) + (1)) >> 0)]) | 0)
        HEAP8[(((dest) + (2)) >> 0)] = ((HEAP8[(((src) + (2)) >> 0)]) | 0)
        HEAP8[(((dest) + (3)) >> 0)] = ((HEAP8[(((src) + (3)) >> 0)]) | 0)
        dest = (dest + 4) | 0
        src = (src + 4) | 0
      }
    }
    // The remaining unaligned < 4 byte tail.
    while ((dest | 0) < (dest_end | 0)) {
      HEAP8[((dest) >> 0)] = ((HEAP8[((src) >> 0)]) | 0)
      dest = (dest + 1) | 0
      src = (src + 1) | 0
    }
    return ret | 0
  }
  function _memset (ptr, value, num) {
    ptr = ptr | 0; value = value | 0; num = num | 0
    var end = 0; var aligned_end = 0; var block_aligned_end = 0; var value4 = 0
    end = (ptr + num) | 0

    value = value & 0xff
    if ((num | 0) >= 67 /* 64 bytes for an unrolled loop + 3 bytes for unaligned head */) {
      while ((ptr & 3) != 0) {
        HEAP8[((ptr) >> 0)] = value
        ptr = (ptr + 1) | 0
      }

      aligned_end = (end & -4) | 0
      value4 = value | (value << 8) | (value << 16) | (value << 24)

      block_aligned_end = (aligned_end - 64) | 0

      while ((ptr | 0) <= (block_aligned_end | 0)) {
        HEAP32[((ptr) >> 2)] = value4
        HEAP32[(((ptr) + (4)) >> 2)] = value4
        HEAP32[(((ptr) + (8)) >> 2)] = value4
        HEAP32[(((ptr) + (12)) >> 2)] = value4
        HEAP32[(((ptr) + (16)) >> 2)] = value4
        HEAP32[(((ptr) + (20)) >> 2)] = value4
        HEAP32[(((ptr) + (24)) >> 2)] = value4
        HEAP32[(((ptr) + (28)) >> 2)] = value4
        HEAP32[(((ptr) + (32)) >> 2)] = value4
        HEAP32[(((ptr) + (36)) >> 2)] = value4
        HEAP32[(((ptr) + (40)) >> 2)] = value4
        HEAP32[(((ptr) + (44)) >> 2)] = value4
        HEAP32[(((ptr) + (48)) >> 2)] = value4
        HEAP32[(((ptr) + (52)) >> 2)] = value4
        HEAP32[(((ptr) + (56)) >> 2)] = value4
        HEAP32[(((ptr) + (60)) >> 2)] = value4
        ptr = (ptr + 64) | 0
      }

      while ((ptr | 0) < (aligned_end | 0)) {
        HEAP32[((ptr) >> 2)] = value4
        ptr = (ptr + 4) | 0
      }
    }
    // The remaining bytes.
    while ((ptr | 0) < (end | 0)) {
      HEAP8[((ptr) >> 0)] = value
      ptr = (ptr + 1) | 0
    }
    return (end - num) | 0
  }

  function dynCall_ii (index, a1) {
    index = index | 0
    a1 = a1 | 0
    return FUNCTION_TABLE_ii[index & 1](a1 | 0) | 0
  }

  function dynCall_iiii (index, a1, a2, a3) {
    index = index | 0
    a1 = a1 | 0; a2 = a2 | 0; a3 = a3 | 0
    return FUNCTION_TABLE_iiii[index & 3](a1 | 0, a2 | 0, a3 | 0) | 0
  }

  function dynCall_iiiii (index, a1, a2, a3, a4) {
    index = index | 0
    a1 = a1 | 0; a2 = a2 | 0; a3 = a3 | 0; a4 = a4 | 0
    return FUNCTION_TABLE_iiiii[index & 3](a1 | 0, a2 | 0, a3 | 0, a4 | 0) | 0
  }

  function b0 (p0) {
    p0 = p0 | 0; nullFunc_ii(0); return 0
  }
  function b1 (p0, p1, p2) {
    p0 = p0 | 0; p1 = p1 | 0; p2 = p2 | 0; nullFunc_iiii(1); return 0
  }
  function b2 (p0, p1, p2, p3) {
    p0 = p0 | 0; p1 = p1 | 0; p2 = p2 | 0; p3 = p3 | 0; nullFunc_iiiii(2); return 0
  }

  // EMSCRIPTEN_END_FUNCS
  var FUNCTION_TABLE_ii = [b0, ___emscripten_stdout_close]
  var FUNCTION_TABLE_iiii = [b1, b1, ___stdio_write, b1]
  var FUNCTION_TABLE_iiiii = [b2, b2, b2, ___emscripten_stdout_seek]

  return { ___errno_location: ___errno_location, _addInt: _addInt, _benchMarkAdd: _benchMarkAdd, _doubleIntArray: _doubleIntArray, _emscripten_get_sbrk_ptr: _emscripten_get_sbrk_ptr, _emscripten_replace_memory: _emscripten_replace_memory, _fflush: _fflush, _free: _free, _malloc: _malloc, _memcpy: _memcpy, _memset: _memset, _sumInt: _sumInt, dynCall_ii: dynCall_ii, dynCall_iiii: dynCall_iiii, dynCall_iiiii: dynCall_iiiii, establishStackSpace: establishStackSpace, stackAlloc: stackAlloc, stackRestore: stackRestore, stackSave: stackSave }
})
// EMSCRIPTEN_END_ASM
(asmGlobalArg, asmLibraryArg, buffer)

var real____errno_location = asm.___errno_location
asm.___errno_location = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real____errno_location.apply(null, arguments)
}

var real__addInt = asm._addInt
asm._addInt = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__addInt.apply(null, arguments)
}

var real__benchMarkAdd = asm._benchMarkAdd
asm._benchMarkAdd = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__benchMarkAdd.apply(null, arguments)
}

var real__doubleIntArray = asm._doubleIntArray
asm._doubleIntArray = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__doubleIntArray.apply(null, arguments)
}

var real__emscripten_get_sbrk_ptr = asm._emscripten_get_sbrk_ptr
asm._emscripten_get_sbrk_ptr = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__emscripten_get_sbrk_ptr.apply(null, arguments)
}

var real__fflush = asm._fflush
asm._fflush = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__fflush.apply(null, arguments)
}

var real__free = asm._free
asm._free = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__free.apply(null, arguments)
}

var real__malloc = asm._malloc
asm._malloc = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__malloc.apply(null, arguments)
}

var real__sumInt = asm._sumInt
asm._sumInt = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real__sumInt.apply(null, arguments)
}

var real_establishStackSpace = asm.establishStackSpace
asm.establishStackSpace = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real_establishStackSpace.apply(null, arguments)
}

var real_stackAlloc = asm.stackAlloc
asm.stackAlloc = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real_stackAlloc.apply(null, arguments)
}

var real_stackRestore = asm.stackRestore
asm.stackRestore = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real_stackRestore.apply(null, arguments)
}

var real_stackSave = asm.stackSave
asm.stackSave = function () {
  assert(runtimeInitialized, 'you need to wait for the runtime to be ready (e.g. wait for main() to be called)')
  assert(!runtimeExited, 'the runtime was exited (use NO_EXIT_RUNTIME to keep it alive after main() exits)')
  return real_stackSave.apply(null, arguments)
}
var ___errno_location = Module.___errno_location = asm.___errno_location
var _addInt = Module._addInt = asm._addInt
var _benchMarkAdd = Module._benchMarkAdd = asm._benchMarkAdd
var _doubleIntArray = Module._doubleIntArray = asm._doubleIntArray
var _emscripten_get_sbrk_ptr = Module._emscripten_get_sbrk_ptr = asm._emscripten_get_sbrk_ptr
var _emscripten_replace_memory = Module._emscripten_replace_memory = asm._emscripten_replace_memory
var _fflush = Module._fflush = asm._fflush
var _free = Module._free = asm._free
var _malloc = Module._malloc = asm._malloc
var _memcpy = Module._memcpy = asm._memcpy
var _memset = Module._memset = asm._memset
var _sumInt = Module._sumInt = asm._sumInt
var establishStackSpace = Module.establishStackSpace = asm.establishStackSpace
var stackAlloc = Module.stackAlloc = asm.stackAlloc
var stackRestore = Module.stackRestore = asm.stackRestore
var stackSave = Module.stackSave = asm.stackSave
var dynCall_ii = Module.dynCall_ii = asm.dynCall_ii
var dynCall_iiii = Module.dynCall_iiii = asm.dynCall_iiii
var dynCall_iiiii = Module.dynCall_iiiii = asm.dynCall_iiiii

// === Auto-generated postamble setup entry stuff ===

Module.asm = asm

if (!Object.getOwnPropertyDescriptor(Module, 'intArrayFromString')) Module.intArrayFromString = function () { abort("'intArrayFromString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'intArrayToString')) Module.intArrayToString = function () { abort("'intArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'ccall')) Module.ccall = function () { abort("'ccall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
Module.cwrap = cwrap
if (!Object.getOwnPropertyDescriptor(Module, 'setValue')) Module.setValue = function () { abort("'setValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getValue')) Module.getValue = function () { abort("'getValue' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'allocate')) Module.allocate = function () { abort("'allocate' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getMemory')) Module.getMemory = function () { abort("'getMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'AsciiToString')) Module.AsciiToString = function () { abort("'AsciiToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stringToAscii')) Module.stringToAscii = function () { abort("'stringToAscii' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'UTF8ArrayToString')) Module.UTF8ArrayToString = function () { abort("'UTF8ArrayToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'UTF8ToString')) Module.UTF8ToString = function () { abort("'UTF8ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stringToUTF8Array')) Module.stringToUTF8Array = function () { abort("'stringToUTF8Array' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stringToUTF8')) Module.stringToUTF8 = function () { abort("'stringToUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'lengthBytesUTF8')) Module.lengthBytesUTF8 = function () { abort("'lengthBytesUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'UTF16ToString')) Module.UTF16ToString = function () { abort("'UTF16ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stringToUTF16')) Module.stringToUTF16 = function () { abort("'stringToUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'lengthBytesUTF16')) Module.lengthBytesUTF16 = function () { abort("'lengthBytesUTF16' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'UTF32ToString')) Module.UTF32ToString = function () { abort("'UTF32ToString' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stringToUTF32')) Module.stringToUTF32 = function () { abort("'stringToUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'lengthBytesUTF32')) Module.lengthBytesUTF32 = function () { abort("'lengthBytesUTF32' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'allocateUTF8')) Module.allocateUTF8 = function () { abort("'allocateUTF8' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stackTrace')) Module.stackTrace = function () { abort("'stackTrace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addOnPreRun')) Module.addOnPreRun = function () { abort("'addOnPreRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addOnInit')) Module.addOnInit = function () { abort("'addOnInit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addOnPreMain')) Module.addOnPreMain = function () { abort("'addOnPreMain' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addOnExit')) Module.addOnExit = function () { abort("'addOnExit' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addOnPostRun')) Module.addOnPostRun = function () { abort("'addOnPostRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'writeStringToMemory')) Module.writeStringToMemory = function () { abort("'writeStringToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'writeArrayToMemory')) Module.writeArrayToMemory = function () { abort("'writeArrayToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'writeAsciiToMemory')) Module.writeAsciiToMemory = function () { abort("'writeAsciiToMemory' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addRunDependency')) Module.addRunDependency = function () { abort("'addRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'removeRunDependency')) Module.removeRunDependency = function () { abort("'removeRunDependency' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'ENV')) Module.ENV = function () { abort("'ENV' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS')) Module.FS = function () { abort("'FS' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createFolder')) Module.FS_createFolder = function () { abort("'FS_createFolder' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createPath')) Module.FS_createPath = function () { abort("'FS_createPath' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createDataFile')) Module.FS_createDataFile = function () { abort("'FS_createDataFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createPreloadedFile')) Module.FS_createPreloadedFile = function () { abort("'FS_createPreloadedFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createLazyFile')) Module.FS_createLazyFile = function () { abort("'FS_createLazyFile' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createLink')) Module.FS_createLink = function () { abort("'FS_createLink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_createDevice')) Module.FS_createDevice = function () { abort("'FS_createDevice' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'FS_unlink')) Module.FS_unlink = function () { abort("'FS_unlink' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") }
if (!Object.getOwnPropertyDescriptor(Module, 'GL')) Module.GL = function () { abort("'GL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'dynamicAlloc')) Module.dynamicAlloc = function () { abort("'dynamicAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'loadDynamicLibrary')) Module.loadDynamicLibrary = function () { abort("'loadDynamicLibrary' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'loadWebAssemblyModule')) Module.loadWebAssemblyModule = function () { abort("'loadWebAssemblyModule' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getLEB')) Module.getLEB = function () { abort("'getLEB' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getFunctionTables')) Module.getFunctionTables = function () { abort("'getFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'alignFunctionTables')) Module.alignFunctionTables = function () { abort("'alignFunctionTables' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'registerFunctions')) Module.registerFunctions = function () { abort("'registerFunctions' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'addFunction')) Module.addFunction = function () { abort("'addFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'removeFunction')) Module.removeFunction = function () { abort("'removeFunction' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getFuncWrapper')) Module.getFuncWrapper = function () { abort("'getFuncWrapper' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'prettyPrint')) Module.prettyPrint = function () { abort("'prettyPrint' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'makeBigInt')) Module.makeBigInt = function () { abort("'makeBigInt' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'dynCall')) Module.dynCall = function () { abort("'dynCall' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getCompilerSetting')) Module.getCompilerSetting = function () { abort("'getCompilerSetting' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stackSave')) Module.stackSave = function () { abort("'stackSave' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stackRestore')) Module.stackRestore = function () { abort("'stackRestore' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'stackAlloc')) Module.stackAlloc = function () { abort("'stackAlloc' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'establishStackSpace')) Module.establishStackSpace = function () { abort("'establishStackSpace' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'print')) Module.print = function () { abort("'print' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'printErr')) Module.printErr = function () { abort("'printErr' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'getTempRet0')) Module.getTempRet0 = function () { abort("'getTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'setTempRet0')) Module.setTempRet0 = function () { abort("'setTempRet0' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'callMain')) Module.callMain = function () { abort("'callMain' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'abort')) Module.abort = function () { abort("'abort' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'Pointer_stringify')) Module.Pointer_stringify = function () { abort("'Pointer_stringify' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
if (!Object.getOwnPropertyDescriptor(Module, 'warnOnce')) Module.warnOnce = function () { abort("'warnOnce' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") }
Module.writeStackCookie = writeStackCookie
Module.checkStackCookie = checkStackCookie
Module.abortStackOverflow = abortStackOverflow; if (!Object.getOwnPropertyDescriptor(Module, 'ALLOC_NORMAL')) Object.defineProperty(Module, 'ALLOC_NORMAL', { configurable: true, get: function () { abort("'ALLOC_NORMAL' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } })
if (!Object.getOwnPropertyDescriptor(Module, 'ALLOC_STACK')) Object.defineProperty(Module, 'ALLOC_STACK', { configurable: true, get: function () { abort("'ALLOC_STACK' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } })
if (!Object.getOwnPropertyDescriptor(Module, 'ALLOC_DYNAMIC')) Object.defineProperty(Module, 'ALLOC_DYNAMIC', { configurable: true, get: function () { abort("'ALLOC_DYNAMIC' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } })
if (!Object.getOwnPropertyDescriptor(Module, 'ALLOC_NONE')) Object.defineProperty(Module, 'ALLOC_NONE', { configurable: true, get: function () { abort("'ALLOC_NONE' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ)") } })
if (!Object.getOwnPropertyDescriptor(Module, 'calledRun')) Object.defineProperty(Module, 'calledRun', { configurable: true, get: function () { abort("'calledRun' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") } })

if (memoryInitializer) {
  if (!isDataURI(memoryInitializer)) {
    memoryInitializer = locateFile(memoryInitializer)
  }
  if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
    var data = readBinary(memoryInitializer)
    HEAPU8.set(data, GLOBAL_BASE)
  } else {
    addRunDependency('memory initializer')
    var applyMemoryInitializer = function (data) {
      if (data.byteLength) data = new Uint8Array(data)
      for (var i = 0; i < data.length; i++) {
        assert(HEAPU8[GLOBAL_BASE + i] === 0, "area for memory initializer should not have been touched before it's loaded")
      }
      HEAPU8.set(data, GLOBAL_BASE)
      // Delete the typed array that contains the large blob of the memory initializer request response so that
      // we won't keep unnecessary memory lying around. However, keep the XHR object itself alive so that e.g.
      // its .status field can still be accessed later.
      if (Module.memoryInitializerRequest) delete Module.memoryInitializerRequest.response
      removeRunDependency('memory initializer')
    }
    var doBrowserLoad = function () {
      readAsync(memoryInitializer, applyMemoryInitializer, function () {
        throw 'could not load memory initializer ' + memoryInitializer
      })
    }
    if (Module.memoryInitializerRequest) {
      // a network request has already been created, just use that
      var useRequest = function () {
        var request = Module.memoryInitializerRequest
        var response = request.response
        if (request.status !== 200 && request.status !== 0) {
          // If you see this warning, the issue may be that you are using locateFile and defining it in JS. That
          // means that the HTML file doesn't know about it, and when it tries to create the mem init request early, does it to the wrong place.
          // Look in your browser's devtools network console to see what's going on.
          console.warn('a problem seems to have happened with Module.memoryInitializerRequest, status: ' + request.status + ', retrying ' + memoryInitializer)
          doBrowserLoad()
          return
        }
        applyMemoryInitializer(response)
      }
      if (Module.memoryInitializerRequest.response) {
        setTimeout(useRequest, 0) // it's already here; but, apply it asynchronously
      } else {
        Module.memoryInitializerRequest.addEventListener('load', useRequest) // wait for it
      }
    } else {
      // fetch it from the network ourselves
      doBrowserLoad()
    }
  }
}

var calledRun

/**
 * @constructor
 * @this {ExitStatus}
 */
function ExitStatus (status) {
  this.name = 'ExitStatus'
  this.message = 'Program terminated with exit(' + status + ')'
  this.status = status
}

var calledMain = false

dependenciesFulfilled = function runCaller () {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!calledRun) run()
  if (!calledRun) dependenciesFulfilled = runCaller // try this again later, after new deps are fulfilled
}

/** @type {function(Array=)} */
function run (args) {
  args = args || arguments_

  if (runDependencies > 0) {
    return
  }

  writeStackCookie()

  preRun()

  if (runDependencies > 0) return // a preRun added a dependency, run will be called later

  function doRun () {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    if (calledRun) return
    calledRun = true

    if (ABORT) return

    initRuntime()

    preMain()

    if (Module.onRuntimeInitialized) Module.onRuntimeInitialized()

    assert(!Module._main, 'compiled without a main, but one is present. if you added it from JS, use Module["onRuntimeInitialized"]')

    postRun()
  }

  if (Module.setStatus) {
    Module.setStatus('Running...')
    setTimeout(function () {
      setTimeout(function () {
        Module.setStatus('')
      }, 1)
      doRun()
    }, 1)
  } else {
    doRun()
  }
  checkStackCookie()
}
Module.run = run

function checkUnflushedContent () {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var print = out
  var printErr = err
  var has = false
  out = err = function (x) {
    has = true
  }
  try { // it doesn't matter if it fails
    var flush = flush_NO_FILESYSTEM
    if (flush) flush(0)
  } catch (e) {}
  out = print
  err = printErr
  if (has) {
    warnOnce('stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the FAQ), or make sure to emit a newline when you printf etc.')
    warnOnce('(this may also be due to not including full filesystem support - try building with -s FORCE_FILESYSTEM=1)')
  }
}

function exit (status, implicit) {
  checkUnflushedContent()

  // if this is just main exit-ing implicitly, and the status is 0, then we
  // don't need to do anything here and can just leave. if the status is
  // non-zero, though, then we need to report it.
  // (we may have warned about this earlier, if a situation justifies doing so)
  if (implicit && noExitRuntime && status === 0) {
    return
  }

  if (noExitRuntime) {
    // if exit() was called, we may warn the user if the runtime isn't actually being shut down
    if (!implicit) {
      err('program exited (with status: ' + status + '), but EXIT_RUNTIME is not set, so halting execution but not exiting the runtime or preventing further async execution (build with EXIT_RUNTIME=1, if you want a true shutdown)')
    }
  } else {
    ABORT = true
    EXITSTATUS = status

    exitRuntime()

    if (Module.onExit) Module.onExit(status)
  }

  quit_(status, new ExitStatus(status))
}

if (Module.preInit) {
  if (typeof Module.preInit === 'function') Module.preInit = [Module.preInit]
  while (Module.preInit.length > 0) {
    Module.preInit.pop()()
  }
}

noExitRuntime = true

run();

// {{MODULE_ADDITIONS}}

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
  Module.portAPI = WASM_API
})()
