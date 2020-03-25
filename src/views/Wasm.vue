<template>
  <div></div>
</template>

<script>
import WasmLoader from '../wasm/loader'

export default {
  mounted () {
    const errLoader = new WasmLoader({
      path: '//member.bilibili.com/studio/static/media-info-v1.7.5111'
    })
    errLoader.load().then(res => {
      console.log(res)
    }).catch(err => {
      console.log(errLoader.getLoaderStatus())
      console.log(err)
    })
    const loader = new WasmLoader({
      path: '/example.out',
      asmPath: '/example1.asm',
      memFile: true
    })
    loader.load({ asm: true }).then(res => {
      console.log('asm')
      const portAPI = res.Module.portAPI
      const count = 10000000
      const a = 100
      const b = 100
      let c = 0
      console.time('js add')
      for (let i = 0; i < count; i++) {
        c = a + b
      }
      console.timeEnd('js add')
      console.time('asm add')
      for (let i = 0; i < count; i++) {
        c = portAPI.addInt(a, b)
      }
      console.timeEnd('asm add')
      console.log(c)
    })
    const loader1 = new WasmLoader({
      path: '/example.out',
      asmPath: '/example.out.asm'
    })
    loader1.load().then(res => {
      console.log(res)
      console.log('wasm')
      const portAPI = res.Module.portAPI
      const count = 10000000
      const a = 100
      const b = 100
      let c = 0
      console.time('js add')
      for (let i = 0; i < count; i++) {
        c = a + b
      }
      console.timeEnd('js add')
      console.time('wasm add')
      for (let i = 0; i < count; i++) {
        c = portAPI.addInt(a, b)
      }
      console.timeEnd('wasm add')
      console.log(c)
    }).catch(res => {
      console.log(res)
    })
    window.loader = loader
    // eslint-disable-next-line
    // const worker = new Worker('./worker.js')
  }
}
</script>
