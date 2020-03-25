
class WasmLoader {
  constructor (config) {
    this.filePath = config.path
    this.config = config
    this.resourceWasm = null
    this.compiledWasm = null
    this.resourceGlue = null
    this.loadingPromise = null
  }

  load (reload = false) {
    if (!this.loadingPromise || reload) {
      this.loadingPromise = Promise.all([this.loadWasmFile(), this.loadGlueFile()]).then(() => {
        return this.instantiateWasm()
      })
    }
    return this.loadingPromise
  }

  fetchFile (url) {
    return fetch(url, { mode: 'cors' }).then(response => {
      if (!response.ok) {
        console.log(response)
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

  loadGlueFile () {
    if (this.resourceGlue) {
      return Promise.resolve()
    }
    return this.fetchFile(`${this.filePath}.js`).then(res => {
      return res.text()
    }).then(text => {
      this.resourceGlue = text
    })
  }

  instantiateWasm () {
    return new Promise((resolve, reject) => {
      const compiledWasm = this.compiledWasm
      const Module = this.config.Module ? Object.assign({}, this.config.Module) : {}
      Module.instantiateWasm = function (imports, successCallback) {
        WebAssembly.instantiate(compiledWasm, imports).then(function (instance) {
          successCallback(instance, compiledWasm)
        }, function (error) {
          reject(error)
        })
        return {}
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
      const glueScript = `${this.resourceGlue};return Module;`
      // eslint-disable-next-line
      const func = new Function('Module', glueScript)
      func(Module)
      resolve(Module)
    })
  }
}

const loader = new WasmLoader({
  path: '//member.bilibili.com/studio/static/media-info-v1.7.5'
})

loader.load().then(res => {
  console.log(111)
})
