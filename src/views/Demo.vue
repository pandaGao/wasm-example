<template>
  <div class="demo-page">
  </div>
</template>

<script>
// import Port from '../wasm/port'

export default {
  data () {
    return {
      WASM: null
    }
  },
  mounted () {
    // Port.onRuntimeInitialized().then((wasm) => {
    //   this.WASM = wasm
    //   this.addBenchMark()
    //   this.sum()
    //   this.doubleArray()
    // })
  },
  methods: {
    addBenchMark () {
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
      c = this.WASM.benchMarkAdd(a, b)
      console.timeEnd('wasm add')
      console.log(c)
    },
    add () {
      const res = this.WASM.addInt(1, 2)
      console.log('1 + 2 =', res)
    },
    sum () {
      const res = this.WASM.sumInt([1, 2, 3])
      console.log('sum [1, 2, 3] =', res)
    },
    doubleArray () {
      const res = this.WASM.doubleIntArray([1, 2, 3])
      console.log('double [1, 2, 3] =', res)
    }
  }
}
</script>

<style lang="less" scoped>

</style>
