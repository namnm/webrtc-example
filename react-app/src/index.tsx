// polyfill for older browsers such as safari on outdate ios
import 'react-app-polyfill/ie11'
import 'react-app-polyfill/stable'
import 'adapterjs'
import 'webrtc-adapter'

import { configure, makeAutoObservable } from 'mobx'
import { observer } from 'mobx-react-lite'
import pokemon from 'pokemon'
import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { toast, ToastContainer } from 'react-toastify'
import { io, Socket } from 'socket.io-client'

import './index.scss'

import type { ClientToServerEvents, ServerToClientEvents } from '../../server'
import noise from './assets/noise.mp3'

configure({ enforceActions: 'never' })

// declare typescript polyfill for older browser such as safari on outdate ios
declare global {
  interface RTCStreamEvent {
    stream: MediaStream
  }
  interface RTCPeerConnection {
    addStream?: (stream: MediaStream) => void
    onaddstream?: (e: RTCStreamEvent) => void
  }
}

/** ----------------------------------------------------------------------------
 * data that affect the UI we put it in state
 */

class State {
  constructor() {
    makeAutoObservable(this)
  }
  status:
    | 'idle'
    | 'webcam-loading'
    | 'webcam-error'
    | 'ws-loading'
    | 'ready-to-queue'
    | 'in-queue'
    | 'webrtc-loading'
    | 'success' = 'idle'
  localName = pokemon.random()
  localStream?: MediaStream
  remoteName = ''
  remoteStream?: MediaStream
  remoteVe?: HTMLVideoElement
}
const state = new State()

const cleanupLocal = (keepName?: boolean) => {
  if (!keepName) {
    state.localName = pokemon.random()
  }
  if (cleanupWebcamListeners) {
    cleanupWebcamListeners()
    cleanupWebcamListeners = undefined
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop())
    state.localStream = undefined
  }
}
const cleanupRemote = () => {
  state.remoteName = ''
  if (state.remoteStream) {
    state.remoteStream.getTracks().forEach(t => t.stop())
    state.remoteStream = undefined
  }
  state.remoteVe = undefined
}
const checkRemoteHasVideo = () => {
  const { remoteStream, remoteVe } = state
  if (!remoteStream || !remoteVe) {
    return
  }
  const { videoWidth, videoHeight } = remoteVe
  if (!videoWidth || !videoHeight) {
    return false
  }
  const c = document.createElement('canvas')
  c.width = videoWidth
  c.height = videoHeight

  c.style.position = 'fixed'
  c.style.top = '-100%'
  c.style.left = '-100%'
  c.style.pointerEvents = 'none'
  document.body.appendChild(c)

  const ctx = c.getContext('2d')
  if (!ctx) {
    document.body.removeChild(c)
    return
  }

  ctx.drawImage(remoteVe, 0, 0, videoWidth, videoHeight)
  const d = ctx.getImageData(0, 0, videoWidth, videoHeight)
  const sum = d.data.reduce((s, v, i) => {
    if (i % 4 === 3) {
      // alpha always 255
      return s
    }
    return s + v
  }, 0)
  const averageRgb = sum / videoWidth / videoHeight / 3

  document.body.removeChild(c)
  return averageRgb > 10
}

setInterval(() => {
  console.log('checkRemoteHasVideo', checkRemoteHasVideo())
}, 2000)

/** ----------------------------------------------------------------------------
 * data that not affect the UI, we declare as static variables here
 */
type MySocket = Socket<ServerToClientEvents, ClientToServerEvents>

let ws: MySocket | undefined = undefined
const cleanupWs = () => {
  if (!ws) {
    return
  }
  ws.removeAllListeners()
  ws.disconnect()
  ws = undefined
}

let peer: RTCPeerConnection | undefined = undefined
const cleanupPeer = () => {
  if (!peer) {
    return
  }
  peer.onicecandidate = null
  peer.onicecandidateerror = null
  peer.ontrack = null
  peer.close()
  peer = undefined
}

/** ----------------------------------------------------------------------------
 * event handlers and logic
 */

let cleanupWebcamListeners: Function | undefined = undefined

const openWebcam = () => {
  console.log('openWebcam')
  state.status = 'webcam-loading'
  playPermissionOnUserInteract()
  navigator.mediaDevices
    .getUserMedia({ audio: true, video: true })
    .then(stream => {
      state.localStream = stream
      startWs()
      const tracks = stream.getTracks()
      const onTrackEnd = () => {
        if (state.status === 'idle') {
          return
        }
        reset(true)
        toast.error('Webcam stopped')
      }
      tracks.forEach(t => t.addEventListener('ended', onTrackEnd))
      cleanupWebcamListeners?.()
      cleanupWebcamListeners = () => {
        tracks.forEach(t => t.removeEventListener('ended', onTrackEnd))
      }
    })
    .catch((err: Error) => {
      state.status = 'webcam-error'
      const msg = err?.message || `${err}`
      toast.error(`Failed to access webcam. Debug: ${msg}`)
    })
}
// to get audio video play permission over browser policy strict on user interaction
// this could solve some case with black remote video if the user has a long time not interact?
const playPermissionOnUserInteract = () => {
  const v = document.createElement('video')
  v.classList.add('invisible')
  v.loop = true
  v.playsInline = true
  v.volume = 0.01
  v.src = noise
  document.body.appendChild(v)
  v.play()?.catch((err: Error) => {
    const msg = err?.message || `${err}`
    toast.error(`Debug: ${msg}`)
  })
  setTimeout(() => document.body.removeChild(v), 1000)
}

const startWs = (rejoinQueue?: boolean) => {
  console.log('startWs')
  cleanupWs()
  state.status = 'ws-loading'
  ws = process.env.NODE_ENV === 'production' ? io() : io('localhost:4000')
  ws.emit('setInfo', {
    name: state.localName,
    // you can send other information, like to authenticate/authorize or user related data here
  })
  ws.on('setInfoSuccess', d => {
    if (d.serverSocketId !== ws?.id) {
      console.error(
        'server socket id not same with client socket id, this should not happen',
      )
    }
    if (!rejoinQueue) {
      state.status = 'ready-to-queue'
    } else {
      joinQueue()
    }
  })
  ws.on('match', onWsMatch)
  ws.on('offer', onWsOffer)
  ws.on('answer', onWsAnswer)
  ws.on('icecandidate', onWsIceCandidate)
  ws.on('leave', onWsLeave)
  ws.on('disconnect', reason => {
    // automatically reconnect if webcam is running
    const isWebcamRunning = cleanupWebcamListeners
    const msg = isWebcamRunning ? 'Reconnecting...' : 'Network error.'
    toast.error(`${msg} Debug: ${reason}`)
    if (!isWebcamRunning) {
      reset(true)
      return
    }
    // automatically reconnect if webcam is running
    const _rejoinQueue =
      state.status === 'in-queue' ||
      state.status === 'webrtc-loading' ||
      state.status === 'success'
    cleanupPeer()
    cleanupRemote()
    startWs(_rejoinQueue)
  })
}
const onWsMatch = (d: {
  roomId: string
  remoteName: string
  createOffer?: boolean
}) => {
  console.log('onWsMatch')
  state.remoteName = d.remoteName
  state.status = 'webrtc-loading'
  toast.success(`Matched with ${d.remoteName}`)
  if (!d.createOffer) {
    return
  }
  createPeerConnection()
}
const onWsOffer = (sdp: RTCSessionDescriptionInit) => {
  console.log('onWsOffer')
  createPeerConnection(sdp)
}
const onWsAnswer = (sdp: RTCSessionDescriptionInit) => {
  console.log('onWsAnswer')
  peer?.setRemoteDescription(new RTCSessionDescription(sdp))
}
const onWsIceCandidate = (candidate: RTCIceCandidate | null) => {
  console.log('onWsIceCandidate')
  if (candidate) {
    peer?.addIceCandidate(new RTCIceCandidate(candidate))
    return
  }
  try {
    // IE compatible
    var ua = window.navigator.userAgent
    if (ua.indexOf('Edge') > -1 || /edg/i.test(ua)) {
      peer?.addIceCandidate(null as any)
    }
  } catch (err) {}
}
const onWsLeave = (d: { remoteId: string; isTimeout?: boolean }) => {
  console.log('onWsLeave')
  if (d.remoteId === ws?.id) {
    return
  }
  const reason = d.isTimeout ? 'disconnected' : 'left'
  toast.info(`${state.remoteName} ${reason}`)
  // this handler will be called whenever if the other participant left
  // we also need to emit to the server to leave the current room and back to queue
  ws?.emit('leave')
  state.status = 'in-queue'
  cleanupPeer()
  cleanupRemote()
}

const createPeerConnection = async (offerSdp?: RTCSessionDescriptionInit) => {
  console.log('createPeerConnection')
  cleanupPeer()
  peer = new RTCPeerConnection({
    iceServers: [
      {
        urls: ['stun:stun.l.google.com:19302'],
      },
      // {
      //   urls: ['turn:xxx.xxx.xxx.xxx:3478', 'turn:xxx.xxx.xxx.xxx:3479'],
      //   username: 'USERNAME',
      //   credential: 'PASSWORD',
      // },
    ],
  })
  peer.onicecandidate = onPeerIceCandidate
  if (peer.addStream) {
    peer.onaddstream = onPeerStream
    if (state.localStream) {
      peer.addStream(state.localStream)
    }
  } else {
    peer.ontrack = onPeerTrack
    state.localStream?.getTracks().forEach(t => peer?.addTrack(t))
  }
  if (!offerSdp) {
    const localSdp = await peer.createOffer()
    peer.setLocalDescription(localSdp)
    ws?.emit('offer', localSdp)
    return
  }
  peer.setRemoteDescription(new RTCSessionDescription(offerSdp))
  const localSdp = await peer.createAnswer()
  peer.setLocalDescription(localSdp)
  ws?.emit('answer', localSdp)
}
const onPeerIceCandidate = (e: RTCPeerConnectionIceEvent) => {
  console.log('onPeerIceCandidate')
  ws?.emit('icecandidate', e.candidate)
}
const onPeerStream = (e: RTCStreamEvent) => {
  console.log('onPeerStream')
  state.remoteStream = e.stream
  state.status = 'success'
}
const onPeerTrack = (e: RTCTrackEvent) => {
  console.log('onPeerTrack')
  if (!state.remoteStream) {
    state.remoteStream = new MediaStream()
  }
  state.remoteStream.addTrack(e.track)
  state.status = 'success'
}

const joinQueue = () => {
  console.log('joinQueue')
  ws?.emit('queue')
  state.status = 'in-queue'
}
const leaveQueue = () => {
  console.log('leaveQueue')
  ws?.emit('unqueue')
  state.status = 'ready-to-queue'
}
const next = () => {
  console.log('next')
  cleanupPeer()
  cleanupRemote()
  ws?.emit('leave')
  state.status = 'in-queue'
}
const forget = () => {
  console.log('forget')
  ws?.emit('forget')
  toast.info('Removed skip/next cache')
}

const reset = (keepName?: boolean) => {
  console.log('reset')
  cleanupWs()
  cleanupPeer()
  cleanupLocal(keepName)
  cleanupRemote()
  state.status = 'idle'
}

export const App = observer(() => {
  const { status, localName, localStream, remoteName, remoteStream } = state
  return (
    <>
      <ToastContainer newestOnTop pauseOnFocusLoss={false} />
      <div className='local'>
        {localStream && <Video muted stream={localStream} />}
        {(status === 'idle' || status === 'webcam-error') && (
          <div className='action button' onClick={openWebcam}>
            Open Webcam
          </div>
        )}
        {status === 'ready-to-queue' && (
          <div className='action button' onClick={joinQueue}>
            Join Queue
          </div>
        )}
        {status === 'in-queue' && (
          <div className='action button' onClick={leaveQueue}>
            Leave Queue
          </div>
        )}
        {status === 'webrtc-loading' ||
          (status === 'success' && (
            <div className='action button' onClick={next}>
              Next
            </div>
          ))}
        <div className='status button' onClick={forget}>
          {localName} | {status}
        </div>
      </div>
      <div className='remote'>
        {remoteStream && <Video stream={remoteStream} remote />}
        {status === 'in-queue' ? (
          <div className='status button'>Waiting for participant...</div>
        ) : remoteName ? (
          <div className='status button'>
            {remoteName}
            {status !== 'success' ? ' | Connecting...' : ''}
          </div>
        ) : null}
      </div>
      <div className='version button'>v0.0.14</div>
    </>
  )
})

const Video = (p: {
  stream: MediaStream
  muted?: boolean
  remote?: boolean
}) => {
  const r = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const v = r.current
    if (!p.stream || !v) {
      return
    }
    if (p.remote) {
      state.remoteVe = v
    }
    v.loop = true
    v.playsInline = true
    v.srcObject = p.stream
    v.play()?.catch((err: Error) => {
      const msg = err?.message || `${err}`
      toast.error(`Debug: ${msg}`)
    })
  }, [p.stream])
  return <video ref={r} loop playsInline controls={false} muted={p.muted} />
}

const div = document.getElementById('root') as HTMLDivElement
createRoot(div).render(<App />)
