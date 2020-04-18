<template>
  <div>
    <input ref="input" type="file" @change="handleSelectVideo">
  </div>
</template>

<script>
export default {
  data () {
    return {

    }
  },
  mounted () {
    const worker = new Worker('/media-info.js')
    worker.addEventListener('message', msg => {
      if (msg.data) {
        switch (msg.data.type) {
          case 'ffmpeg.loaded':
            worker.postMessage({
              type: 'run',
              method: 'version',
              args: []
            })
            break
          default:
            console.log(msg.data)
        }
      }
    })
    this.worker = worker
  },
  methods: {
    handleSelectVideo (e) {
      const file = e.target.files[0]
      const mounts = [
        {
          type: 'WORKERFS',
          opts: {
            files: [file]
          },
          mountpoint: '/data'
        }
      ]
      const command = `/data/${file.name}`
      this.worker.postMessage({
        type: 'run',
        method: 'getMediaInfo',
        mounts,
        args: [command]
      })
    }
  }
}
</script>

<style lang="stylus" scoped>

</style>
