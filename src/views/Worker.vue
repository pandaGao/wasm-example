<template>
  <div class="wroker"></div>
</template>

<script>
export default {
  mounted () {
    const worker = new Worker('/worker.js')
    worker.addEventListener('message', msg => {
      if (msg.data) {
        switch (msg.data.type) {
          case 'wasm-loader.loaded':
            worker.postMessage({
              type: 'wasm-loader.callModuleFunction',
              function: 'portAPI.helloWorld'
            })
            worker.postMessage({
              type: 'wasm-loader.callModuleFunction',
              function: 'portAPI.doubleIntArray',
              args: [
                [1, 2, 3, 4, 5]
              ]
            })
            worker.postMessage({
              type: 'doubleIntArray',
              array: [1, 2, 3, 4, 5]
            })
            worker.postMessage({
              type: 'wasm-loader.callModuleFunction',
              function: 'portAPI.doubleIntArray',
              args: [
                [2, 4]
              ]
            })
            break
          default:
            console.log(msg.data)
        }
      }
    })
    worker.postMessage({
      type: 'wasm-loader.load',
      config: {
        path: '/example.out'
      }
    })
  }
}
</script>
