/**
 * WasmLoader
 *
 * Load emscripten output wasm & js resource with promise
 *
 * @example
 * let loader = new WasmLoader({ path: '/xxx.out' })
 * loader.load().then(res => { let Module = res.Module // ... call Module function })
 */

export default class WasmLoader {
  /**
   * Create a wasm loader
   * @param {Object}  config - loader config
   * @param {String}  config.path - base path for wasm & js file without extension e.g. '/example.out'
   * @param {String}  [config.asmPath = ''] - path for asm.js file e.g. '/example.asm'
   * @param {Boolean} [config.memFile = false] - use asm.js with memory init file
   * @param {Object}  [config.fetchInit = {}] - 'init' Object for fetching wasm & js resource. See https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch
   * @param {Object}  [config.Module = {}] - extend emscripten output 'Module' object. See https://emscripten.org/docs/api_reference/module.html
   */
  constructor (config) {
    this.filePath = config.path
    this.fetchInit = config.fetchInit || {}
    this.config = config
    this.asmPath = config.asmPath || ''
    this.memFile = config.memFile !== undefined ? config.memFile : false
    if (this.asmPath.endsWith && !this.asmPath.endsWith('.js')) {
      this.asmPath = this.asmPath + '.js'
    }
    this.resourceWasm = null
    this.compiledWasm = null
    this.resourceJs = null
    this.exportModule = null
    this.useAsm = false
    this.memRequest = null
    this.status = 'waiting'
    this.loadingPromise = null
  }

  isSupportedWebAssembly () {
    return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
  }

  getLoaderStatus () {
    const statusObj = {
      status: this.status
    }
    if (this.status !== 'waiting') {
      if (this.useAsm) {
        statusObj.useAsm = true
      } else {
        statusObj.useWasm = true
      }
    }
    if (this.status === 'loaded') {
      statusObj.Module = this.exportModule
    }
    return statusObj
  }

  /**
   * Load all resource and instantiate wasm
   * @param {Object} option
   * @param {Boolean} option.reload - force reload resource
   * @param {Boolean} option.asm - force load asm.js code
   */

  load ({ reload = false, asm = false } = {}) {
    const isSupportedWebAssembly = this.isSupportedWebAssembly()
    if (!isSupportedWebAssembly && !this.asmPath) {
      return Promise.reject(new Error('WebAssembly is not supported'))
    }
    if (!this.loadingPromise || reload) {
      const loadList = []
      this.resourceWasm = null
      this.compiledWasm = null
      this.resourceJs = null
      this.exportModule = null
      this.memRequest = null
      this.status = 'waiting'
      if (this.asmPath && (!isSupportedWebAssembly || asm)) {
        loadList.push(this.loadJsFile(this.asmPath))
        if (this.memFile) {
          loadList.push(this.loadMemFile())
        }
        this.useAsm = true
      } else {
        loadList.push(this.loadJsFile())
        loadList.push(this.loadWasmFile())
        this.useAsm = false
      }
      this.status = 'loading'
      this.loadingPromise = Promise.all(loadList).then(() => {
        return this.initializeRuntime({ asm })
      })
    }
    return this.loadingPromise
  }

  fetchFile (url) {
    return fetch(url, this.fetchInit).then(response => {
      if (!response.ok) {
        const error = new Error(`Fetch failed with ${response.status} ${response.statusText}`)
        return Promise.reject(error)
      } else {
        return response
      }
    })
  }

  compileStreamingWasm (response) {
    return response.arrayBuffer().then(bytes => {
      return WebAssembly.compile(bytes)
    })
  }

  loadWasmFile () {
    if (this.resourceWasm) {
      return Promise.resolve()
    }
    const resource = this.resourceWasm ? Promise.resolve() : this.fetchFile(`${this.filePath}.wasm`).then(res => { this.resourceWasm = res })
    return resource.then(() => {
      if (typeof WebAssembly.compileStreaming !== 'undefined') {
        return WebAssembly.compileStreaming(this.resourceWasm).catch(() => {
          return this.compileStreamingWasm(this.resourceWasm)
        })
      } else {
        return this.compileStreamingWasm(this.resourceWasm)
      }
    }).then(wasm => {
      this.compiledWasm = wasm
    })
  }

  loadJsFile (url) {
    if (this.resourceJs) {
      return Promise.resolve()
    }
    return this.fetchFile(url || `${this.filePath}.js`).then(res => {
      return res.text()
    }).then(text => {
      this.resourceJs = text
    })
  }

  loadMemFile () {
    if (this.memRequest) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      var xhr = new XMLHttpRequest()
      this.memRequest = xhr
      xhr.open('GET', `${this.asmPath}.mem`, true)
      xhr.responseType = 'arraybuffer'
      xhr.onload = () => {
        if (xhr.status === 200 || (xhr.status === 0 && xhr.response)) { // file URLs can return 0
          resolve(xhr.response)
          return
        }
        reject(new Error(`Request .mem file failed with ${xhr.status}`))
      }
      xhr.onerror = () => {
        reject(new Error(`Request .mem file failed with ${xhr.status}`))
      }
      xhr.send(null)
    })
  }

  initializeRuntime ({ asm = false }) {
    this.status = 'initializing'
    return new Promise((resolve, reject) => {
      const compiledWasm = this.compiledWasm
      const Module = this.config.Module ? Object.assign({}, this.config.Module) : {}
      if (!asm) {
        Module.instantiateWasm = (imports, successCallback) => {
          WebAssembly.instantiate(compiledWasm, imports).then(instance => {
            successCallback(instance, compiledWasm)
            this.useAsm = false
            this.status = 'loaded'
            this.exportModule = Module
            resolve(this.getLoaderStatus())
          }, error => {
            reject(error)
          })
          return {}
        }
      }
      if (asm && this.memFile) {
        Module.memoryInitializerRequest = this.memRequest
        Module.onRuntimeInitialized = () => {
          this.useAsm = false
          this.status = 'loaded'
          this.exportModule = Module
          resolve(this.getLoaderStatus())
        }
      }
      Module.print = Module.print || function (text) {
        console.log(text)
      }
      Module.printErr = Module.printErr || function (text) {
        console.error(text)
      }
      Module.onAbort = Module.onAbort || function (text) {
        console.error(text)
      }
      const moduleScript = `${this.resourceJs};return Module;`
      // eslint-disable-next-line
      const func = new Function('Module', moduleScript)
      func(Module)
      if (asm && !this.memFile) {
        this.useAsm = true
        this.status = 'loaded'
        this.exportModule = Module
        resolve(this.getLoaderStatus())
      }
    })
  }
}
