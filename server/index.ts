import http from 'http'
import { integer, nodeCrypto } from 'random-js'
import { Server, Socket } from 'socket.io'

import {
  processQueueInterval,
  skipTimeout,
  wsPingInterval,
  wsPingTimeout,
} from './config'

export type ClientToServerEvents = {
  setInfo: (d: { name: string }) => void

  queue: () => void
  unqueue: () => void
  leave: () => void
  forget: () => void

  offer: (d: RTCSessionDescriptionInit) => void
  answer: (d: RTCSessionDescriptionInit) => void
  icecandidate: (d: RTCIceCandidate | null) => void
}

export type ServerToClientEvents = {
  setInfoSuccess: (d: { serverSocketId: string }) => void
  invalid: () => void

  match: (d: {
    roomId: string
    remoteName: string
    createOffer?: boolean
  }) => void
  leave: (d: { remoteId: string; isTimeout?: boolean }) => void

  offer: (d: RTCSessionDescriptionInit) => void
  answer: (d: RTCSessionDescriptionInit) => void
  icecandidate: (d: RTCIceCandidate | null) => void
}

type SocketData = {
  name?: string
  roomId?: string
  skip?: { [otherId: string]: number }
}

type MySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>

const server = http.createServer()
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
  pingInterval: wsPingInterval,
  pingTimeout: wsPingTimeout,
})
io.on('connection', (s: MySocket) => {
  console.log(`on ws connection, id=${s.id} recovered=${s.recovered}`)
  /** --------------------------------------------------------------------------
   * init events
   */
  s.on('setInfo', d => {
    s.data.name = d.name
    s.emit('setInfoSuccess', {
      serverSocketId: s.id,
    })
  })
  /** --------------------------------------------------------------------------
   * queue and room events
   */
  s.on('queue', () => {
    addToQueue(s)
  })
  s.on('unqueue', () => {
    queue = queue.filter(_ => _ !== s)
  })
  s.on('leave', () => {
    setSkip(s)
    leaveRoom(s)
    addToQueue(s)
  })
  s.on('forget', () => {
    delete s.data.skip
  })
  /** --------------------------------------------------------------------------
   * webrtc signaling events
   */
  s.on('offer', (d: RTCSessionDescriptionInit) => {
    getTheOtherInRoom(s)?.emit('offer', d)
  })
  s.on('answer', (d: RTCSessionDescriptionInit) => {
    getTheOtherInRoom(s)?.emit('answer', d)
  })
  s.on('icecandidate', (d: RTCIceCandidate | null) => {
    getTheOtherInRoom(s)?.emit('icecandidate', d)
  })
  /** --------------------------------------------------------------------------
   * handle disconnect
   */
  s.on('disconnect', reason => {
    queue = queue.filter(_ => _ !== s)
    leaveRoom(s, reason === 'ping timeout')
  })
})

let queue: MySocket[] = []
const addToQueue = (s: MySocket) => {
  if (queue.includes(s)) {
    console.error(`${s.data.name} already in the queue`)
    return
  }
  if (s.data.roomId) {
    console.error(`${s.data.name} already in a room`)
    return
  }
  queue.push(s)
}
const processQueue = () => {
  if (queue.length <= 1) {
    return
  }
  const s1 = queue.shift() as MySocket
  const notskip = queue.filter(_ => !checkSkipEither(s1, _))
  const s2 = notskip[integer(0, notskip.length - 1)(nodeCrypto)]
  if (s2) {
    queue = queue.filter(_ => _ !== s2)
    pair(s1, s2)
  }
  processQueue()
  if (!s2) {
    queue.unshift(s1)
  }
}
setInterval(processQueue, processQueueInterval)

const pair = (s1: MySocket, s2: MySocket) => {
  // check if the name is set
  // this could happen in some edge cases that the web socket reconnect
  // and emit events incorrectly because of the network error
  if (!s1.data.name) {
    s1.emit('invalid')
    if (s2.data.name) {
      queue.push(s2)
    }
    return
  }
  if (!s2.data.name) {
    s2.emit('invalid')
    if (s1.data.name) {
      queue.push(s1)
    }
    return
  }
  // check if the roomId is set
  // this could happen in some edge cases that the web socket reconnect
  // and emit events incorrectly because of the network error
  if (s1.data.roomId) {
    leaveRoom(s1)
  }
  if (s2.data.roomId) {
    leaveRoom(s2)
  }
  // actual join room and emit to the frontend
  const roomId = joinRoom(s1, s2)
  s1.emit('match', {
    roomId,
    remoteName: s2.data.name,
    createOffer: true,
  })
  s2.emit('match', {
    roomId,
    remoteName: s1.data.name,
    createOffer: false,
  })
}

const rooms: { [roomId: string]: MySocket[] } = {}
const joinRoom = (s1: MySocket, s2: MySocket) => {
  const roomId = [s1.id, s2.id].sort().join(',')
  s1.data.roomId = roomId
  s2.data.roomId = roomId
  rooms[roomId] = [s1, s2]
  return roomId
}
const leaveRoom = (s: MySocket, isTimeout?: boolean) => {
  if (!s.data.roomId) {
    return
  }
  const other = getTheOtherInRoom(s)
  if (other) {
    delete other.data.roomId
    other.emit('leave', {
      remoteId: s.id,
      isTimeout: false,
    })
  }
  delete rooms[s.data.roomId]
  delete s.data.roomId
}
const getTheOtherInRoom = (s: MySocket) => {
  if (!s.data.roomId) {
    return
  }
  return rooms[s.data.roomId]?.find(_ => _ !== s)
}

const setSkip = (s: MySocket) => {
  const other = getTheOtherInRoom(s)
  if (!other) {
    return
  }
  if (!s.data.skip) {
    s.data.skip = {}
  }
  s.data.skip[other.id] = Date.now()
}
const checkSkip = (s: MySocket, other: MySocket) => {
  if (!s.data.skip) {
    return false
  }
  const t = s.data.skip[other.id]
  if (!t) {
    return false
  }
  if (Date.now() - t < skipTimeout) {
    return true
  }
  delete s.data.skip[other.id]
  return false
}
const checkSkipEither = (s1: MySocket, s2: MySocket) =>
  checkSkip(s1, s2) || checkSkip(s2, s1)

const port = 4000
console.log(`prepare to listen on port ${port}`)
server
  .listen(port)
  .on('error', console.error)
  .on('listening', () => {
    console.log(`listening on port ${port}`)
  })

process.on('uncaughtException', console.error)
process.on('unhandledRejection', console.error)
