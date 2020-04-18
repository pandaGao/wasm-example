/* eslint-disable no-undef */

(function (Module) {
  function __ffmpegjs_toU8 (data) {
    if (Array.isArray(data) || data instanceof ArrayBuffer) {
      data = new Uint8Array(data)
    } else if (!data) {
      // `null` for empty files.
      data = new Uint8Array(0)
    } else if (!(data instanceof Uint8Array)) {
      // Avoid unnecessary copying.
      data = new Uint8Array(data.buffer)
    }
    return data
  }

  function FSMount (mounts) {
    if (mounts && mounts.length) {
      mounts.forEach(mount => {
        var fs = FS.filesystems[mount.type]
        if (!fs) {
          throw new Error('Bad mount type')
        }
        var mountpoint = mount.mountpoint
        // NOTE(Kagami): Subdirs are not allowed in the paths to simplify
        // things and avoid ".." escapes.
        if (!mountpoint.match(/^\/[^/]+$/) ||
          mountpoint === '/.' ||
          mountpoint === '/..' ||
          mountpoint === '/tmp' ||
          mountpoint === '/home' ||
          mountpoint === '/dev' ||
          mountpoint === '/work') {
          throw new Error('Bad mount point')
        }
        FS.mkdir(mountpoint)
        FS.mount(fs, mount.opts, mountpoint)
      })
    }
  }

  function FSUnmount (mounts) {
    if (mounts && mounts.length) {
      mounts.forEach(mount => {
        var mountpoint = mount.mountpoint
        FS.unmount(mountpoint)
        FS.rmdir(mountpoint)
      })
    }
  }

  function getOutFile () {
    function listFiles (dir) {
      var contents = FS.lookupPath(dir).node.contents
      var filenames = Object.keys(contents)
      return filenames.map(function (filename) {
        return contents[filename]
      })
    }
    var outFiles = listFiles('/data').filter(function (file) {
      return !(file.name in inFiles)
    }).map(function (file) {
      var data = __ffmpegjs_toU8(file.contents)
      return { name: file.name, data: data }
    })
    return outFiles
  }

  const portAPI = {
    version: Module.cwrap('version', 'string', []),
    getMediaInfo (filename) {
      const func = Module.cwrap('mediaInfo', 'string', ['string'])
      const res = func(filename)
      if (res) {
        return JSON.parse(res)
      }
      return ''
    },
    convertToMP3 (filename) {
      const func = Module.cwrap('convertToMP3', 'number', ['string'])
      const res = func(filename)
      console.log(res)
      const files = getOutFile()
      return files
    }
  }

  Module.portAPI = portAPI

  self.onmessage = function (e) {
    const message = e.data
    if (message.type === 'run') {
      if (message.mounts) {
        FSMount(message.mounts)
      }
      const res = portAPI[message.method](...message.args)
      if (res) {
        self.postMessage({
          type: 'ffmpeg.res',
          data: res
        })
      }
      if (message.mounts) {
        FSUnmount(message.mounts)
      }
    }
  }

  Module.onRuntimeInitialized = () => {
    self.postMessage({
      type: 'ffmpeg.loaded'
    })
  }
})(Module)
