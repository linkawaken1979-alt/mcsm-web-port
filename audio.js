globalThis.MCSMFmod = (() => {
  const library = "fmodstudio.js"
  const OK = 0
  const ERR_INVALID_HANDLE = 30
  const ERR_INVALID_PARAM = 31
  const ERR_TRUNCATED = 45
  const ERR_EVENT_NOTFOUND = 74
  const ZERO = "00000000000000000000000000000000"
  const frequencies = [4000, 8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 96000]
  const hex = []
  for (let i = 0; i < 256; i++) hex.push(i.toString(16).padStart(2, "0"))
  const objects = new Map()
  const callbacks = []
  const names = []
  const unknown = new Set()
  const paths = new Map()
  const descriptions = new Map()
  const busObjects = new Map()
  const bankHandles = []
  const M = {events: new Map(), timelines: new Map(), layouts: new Map(), params: new Map(), instruments: new Map(), buses: new Map(), transitions: new Map(), effects: new Map(), snapshots: new Set()}
  let nextHandle = 0x7e000010
  let pendingFile = null
  let pendingAt = 0
  let FMOD = null
  let studioSystem = null
  let lowSystem = null
  let fileCounter = 0
  let masterGroupHandle = null
  let decoder = null

  const u32 = address => Module.HEAPU32[address >>> 2] >>> 0
  const i32 = address => Module.HEAPU32[address >>> 2] | 0
  const f32 = address => Module.HEAPF32[address >>> 2]
  const put32 = (address, value) => { if (address) Module.HEAPU32[address >>> 2] = value >>> 0 }
  const putf = (address, value) => { if (address) Module.HEAPF32[address >>> 2] = value }
  const put8 = (address, value) => { if (address) Module.HEAPU8[address >>> 0] = value ? 1 : 0 }
  const cstring = address => {
    let text = ""
    for (let index = address >>> 0; Module.HEAPU8[index] && text.length < 1024; index++) text += String.fromCharCode(Module.HEAPU8[index])
    return text
  }
  const guestText = (owner, field, text) => {
    if (!owner[field]) {
      owner[field] = Module._malloc(text.length + 1)
      for (let i = 0; i < text.length; i++) Module.HEAPU8[owner[field] + i] = text.charCodeAt(i)
      Module.HEAPU8[owner[field] + text.length] = 0
    }
    return owner[field]
  }
  const guid = address => {
    let text = ""
    for (let index = 0; index < 16; index++) text += hex[Module.HEAPU8[address + index]]
    return text
  }
  const putGuid = (address, key) => {
    if (address) for (let i = 0; i < 16; i++) Module.HEAPU8[address + i] = parseInt(key.substr(i * 2, 2), 16)
  }

  function create(kind, fields) {
    const handle = nextHandle
    nextHandle += 16
    const object = Object.assign({handle, kind, userData: 0}, fields)
    objects.set(handle, object)
    return object
  }

  const system = create("system", {})
  const masterGroup = create("group", {})
  const studio = create("studio", {})

  function bind(imports) {
    for (const item of imports) {
      if (!/^fmod(studio)?\.dll$/i.test(item.library)) continue
      const match = /^\?([^@]+)@([^@]+)@(Studio@)?FMOD@@/.exec(item.name)
      names[item.index] = match ? (match[3] ? "Studio." : "") + match[2] + "." + match[1] : item.name
    }
  }

  class Reader {
    constructor(bytes, offset, end) {
      this.bytes = bytes
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      this.o = offset
      this.end = end
    }
    left() { return this.end - this.o }
    u8() { return this.o + 1 <= this.end ? this.bytes[this.o++] : 0 }
    u16() { if (this.o + 2 > this.end) { this.o = this.end; return 0 } const v = this.view.getUint16(this.o, true); this.o += 2; return v }
    u32() { if (this.o + 4 > this.end) { this.o = this.end; return 0 } const v = this.view.getUint32(this.o, true); this.o += 4; return v }
    f32() { if (this.o + 4 > this.end) { this.o = this.end; return 0 } const v = this.view.getFloat32(this.o, true); this.o += 4; return v }
    guid() {
      if (this.o + 16 > this.end) { this.o = this.end; return ZERO }
      let s = ""
      for (let i = 0; i < 16; i++) s += hex[this.bytes[this.o + i]]
      this.o += 16
      return s
    }
    string() {
      const n = this.u16()
      let s = ""
      for (let i = 0; i < n && this.o < this.end; i++) s += String.fromCharCode(this.bytes[this.o++])
      return s
    }
    array(fn) {
      let h = this.u16()
      if (h & 0x8000) {
        const hi = this.u16()
        const v = (hi << 16) | h
        h = ((v >>> 1) & 0xffffc000) | (v & 0x3fff)
      }
      const count = h >>> 1, fixed = h & 1
      const out = []
      if (count > this.left()) { this.o = this.end; return out }
      let size = 0
      for (let i = 0; i < count; i++) {
        if (!fixed || i === 0) size = this.u16()
        if (this.o + size > this.end) { this.o = this.end; break }
        const start = this.o
        out.push(fn(new Reader(this.bytes, start, Math.min(this.end, start + size))))
        this.o = start + size
      }
      return out
    }
  }

  function bankLists(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const lists = []
    const visit = (offset, end) => {
      const node = {type: "", chunks: [], lists: []}
      while (offset + 8 <= end) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
        const size = view.getUint32(offset + 4, true)
        if (id === "RIFF" || id === "LIST") {
          const child = visit(offset + 12, Math.min(end, offset + 8 + size))
          child.type = String.fromCharCode(bytes[offset + 8], bytes[offset + 9], bytes[offset + 10], bytes[offset + 11])
          node.lists.push(child)
          lists.push(child)
        } else node.chunks.push({id, offset: offset + 8, size})
        offset += 8 + size + (size & 1)
      }
      return node
    }
    visit(0, bytes.length)
    return lists
  }

  function bankStrings(chunk) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const node = index => {
      const a = view.getUint32(8 + index * 8, true), b = view.getUint32(12 + index * 8, true)
      return [a & 0xffffff, a >>> 24, b & 0xffffff, b >>> 24]
    }
    let count = 1
    let leaves = 0
    const stack = [0]
    while (stack.length) {
      const [, , first, children] = node(stack.pop())
      if (!children) { leaves++; continue }
      for (let child = 0; child < children; child++) stack.push(first + child)
      count = Math.max(count, first + children)
    }
    const guidBase = 8 + count * 8 + 4
    const pool = guidBase + leaves * 16 + 4
    const labelText = offset => {
      let text = ""
      for (let index = pool + offset; index < chunk.length && chunk[index]; index++) text += String.fromCharCode(chunk[index])
      return text
    }
    const guidAt = offset => { let s = ""; for (let i = 0; i < 16; i++) s += hex[chunk[offset + i]]; return s }
    const map = {}
    const visit = (index, prefix) => {
      const [label, char, first, children] = node(index)
      const text = index ? prefix + (label !== 0xffffff ? labelText(label) : char ? String.fromCharCode(char) : "") : ""
      if (!children) { if (first < leaves) map[guidAt(guidBase + first * 16)] = text; return }
      for (let child = 0; child < children; child++) visit(first + child, text)
    }
    visit(0, "")
    return map
  }

  function parseBank(bytes) {
    const model = {events: new Map(), timelines: new Map(), layouts: new Map(), params: new Map(), instruments: new Map(), buses: new Map(), transitions: new Map(), effects: new Map(), snapshots: new Set(), paths: {}}
    const chunk = (list, id) => list.chunks.find(c => c.id === id) || null
    const reader = c => new Reader(bytes, c.offset, c.offset + c.size)
    const playlist = list => {
      const c = chunk(list, "PLST")
      if (!c) return []
      const r = reader(c)
      r.u32()
      r.u32()
      return r.array(e => e.guid())
    }
    const instrument = (list, id, fields) => {
      const c = chunk(list, id)
      if (c) model.instruments.set(reader(c).guid(), fields)
      return c
    }
    for (const list of bankLists(bytes)) {
      switch (list.type) {
        case "EVNT": {
          const c = chunk(list, "EVTB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          r.guid()
          const timeline = r.guid()
          const inputBus = r.guid()
          const masterBus = r.guid()
          r.u32()
          r.u32()
          r.u32()
          r.u8()
          const eventParams = r.array(e => e.guid())
          const numbers = r.left() >= 2 ? r.array(e => ({name: e.string(), value: e.u32()})) : []
          const strings = r.left() >= 2 ? r.array(e => ({name: e.string(), value: e.string()})) : []
          model.events.set(id, {timeline, inputBus, masterBus, params: eventParams, numbers, strings})
          break
        }
        case "TMLN": {
          const c = chunk(list, "TLNB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          r.guid()
          const place = e => ({instrument: e.guid(), start: e.u32() / 48, length: e.u32() / 48})
          const placements = r.array(place).concat(r.array(place))
          r.array(e => e.u32())
          const markers = r.array(e => ({id: e.guid(), position: e.u32() / 48}))
          const transitions = []
          const group = list.lists.find(l => l.type === "TRNS")
          if (group) for (const item of group.lists) {
            const tc = chunk(item, "TRNB")
            if (!tc) continue
            const tr = reader(tc)
            const tid = tr.guid()
            const destination = tr.guid()
            tr.u32()
            const end = tr.u32() / 48
            transitions.push(tid)
            model.transitions.set(tid, {destination, end, conditional: tr.guid() !== ZERO})
          }
          model.timelines.set(id, {placements, markers, transitions})
          break
        }
        case "PMLO": {
          const c = chunk(list, "PMLB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          r.guid()
          const event = r.guid()
          model.layouts.set(id, {event, placements: r.array(e => ({instrument: e.guid()}))})
          break
        }
        case "PARM": {
          const c = chunk(list, "PRMB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          r.u8()
          const type = r.u32()
          const name = r.string()
          model.params.set(id, {id, type, name, min: r.f32(), max: r.f32(), def: r.f32()})
          break
        }
        case "WAIT": {
          const c = chunk(list, "WAIB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          model.instruments.set(id, {type: "wave", loop: (r.u32() & 2) !== 0})
          break
        }
        case "MUIT": instrument(list, "MUIB", {type: "multi", playlist: playlist(list)}); break
        case "SPIT": instrument(list, "SPIB", {type: "scatter", playlist: playlist(list)}); break
        case "PRIT": instrument(list, "PRIB", {type: "programmer"}); break
        case "EVIT": {
          const c = chunk(list, "EVIB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          model.instruments.set(id, {type: "event", event: r.guid()})
          break
        }
        case "GBUS": case "IBUS": case "RBUS": case "MBUS": {
          const c = chunk(list, list.type === "GBUS" ? "GBSB" : list.type === "IBUS" ? "IBSB" : list.type === "RBUS" ? "RBSB" : "MBSB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          let output = ZERO
          if (r.left() >= 18) { r.u16(); output = r.guid() }
          let effects = []
          const busChunk = chunk(list, "BUS ")
          if (busChunk) {
            const br = reader(busChunk)
            br.u8()
            br.u32()
            const first = br.array(e => e.guid())
            effects = first.concat(br.array(e => e.guid()))
          }
          model.buses.set(id, {kind: list.type, output, effects})
          break
        }
        case "BEFF": {
          const c = chunk(list, "BEFB")
          if (!c) break
          const r = reader(c)
          const id = r.guid()
          r.u32()
          const effect = {dspType: r.u32(), params: []}
          const pm = chunk(list, "PMEF")
          if (pm) {
            const pr = reader(pm)
            const count = pr.u32()
            for (let i = 0; i < count && pr.left() >= 8; i++) {
              const kind = pr.u32()
              if (kind === 0) effect.params.push(pr.f32())
              else if (kind === 1) effect.params.push(pr.u32())
              else if (kind === 2) effect.params.push(pr.u8())
              else if (kind === 3) { const n = pr.u16(); pr.o += n; effect.params.push(null) }
              else break
            }
          }
          model.effects.set(id, effect)
          break
        }
        case "SNAP": {
          const c = chunk(list, "SNAB")
          if (c) model.snapshots.add(reader(c).guid())
          break
        }
        case "PROJ": {
          const c = chunk(list, "STDT")
          if (c) { try { Object.assign(model.paths, bankStrings(bytes.subarray(c.offset, c.offset + c.size))) } catch (error) {} }
          break
        }
      }
    }
    return model
  }

  function mergeModel(model) {
    for (const key of ["events", "timelines", "params", "instruments", "buses", "transitions", "effects"]) for (const [id, value] of model[key]) M[key].set(id, value)
    for (const [id, layout] of model.layouts) {
      if (!M.layouts.has(layout.event)) M.layouts.set(layout.event, new Map())
      M.layouts.get(layout.event).set(id, layout)
    }
    for (const id of model.snapshots) M.snapshots.add(id)
    for (const [key, value] of Object.entries(model.paths)) paths.set(key, value)
    for (const description of descriptions.values()) description.info = null
  }

  function describe(key) {
    let description = descriptions.get(key)
    if (!description) {
      description = create("description", {guid: key, info: null})
      descriptions.set(key, description)
    }
    if (!description.info) description.info = analyseEvent(key, 0)
    return description
  }

  function analyseEvent(key, nesting) {
    const event = M.events.get(key)
    const info = {event, params: [], length: 0, oneshot: true, is3D: false}
    if (!event || nesting > 6) return info
    for (const id of event.params) {
      const param = M.params.get(id)
      if (param) info.params.push(param)
      if (param && param.type === 1) info.is3D = true
    }
    const visit = (id, depth) => {
      const instrument = M.instruments.get(id)
      if (!instrument || depth > 6) return
      if (instrument.type === "wave" && instrument.loop) info.oneshot = false
      if (instrument.type === "scatter") info.oneshot = false
      if (instrument.playlist) for (const entry of instrument.playlist) visit(entry, depth + 1)
      if (instrument.type === "event" && !analyseEvent(instrument.event, nesting + 1).oneshot) info.oneshot = false
    }
    const timeline = M.timelines.get(event.timeline)
    if (timeline) {
      for (const placement of timeline.placements) {
        info.length = Math.max(info.length, placement.start + placement.length)
        visit(placement.instrument, 0)
      }
      for (const id of timeline.transitions) {
        const transition = M.transitions.get(id)
        if (!transition) continue
        const marker = timeline.markers.find(item => item.id === transition.destination)
        if (marker && marker.position < transition.end && !transition.conditional) info.oneshot = false
      }
    }
    for (const layout of (M.layouts.get(key) || new Map()).values()) for (const placement of layout.placements) visit(placement.instrument, 0)
    if (M.snapshots.has(key)) info.oneshot = false
    const master = M.buses.get(event.masterBus)
    if (master) for (const id of master.effects) {
      const effect = M.effects.get(id)
      if (effect && effect.dspType === 27 && effect.params[17] > 0) info.is3D = true
    }
    return info
  }

  function mixerBuses(bank) {
    if (!bank) return []
    if (bank.mixer) return bank.mixer
    const model = bank.model
    const owned = new Set()
    for (const event of model.events.values()) { owned.add(event.masterBus); owned.add(event.inputBus) }
    const known = new Map()
    const shared = id => {
      if (known.has(id)) return known.get(id)
      known.set(id, false)
      const bus = model.buses.get(id)
      let result = false
      if (bus && !owned.has(id) && bus.kind !== "IBUS") result = bus.kind === "MBUS" ? true : shared(bus.output)
      known.set(id, result)
      return result
    }
    bank.mixer = [...model.buses.keys()].filter(shared)
    return bank.mixer
  }

  const bankEvents = bank => bank ? [...bank.model.events.keys()].filter(key => !M.snapshots.has(key)) : []

  function writePath(key, output, size, retrieved) {
    const text = paths.get(key)
    if (text === undefined) { if (output && size > 0) Module.HEAPU8[output] = 0; put32(retrieved, 0); return ERR_EVENT_NOTFOUND }
    put32(retrieved, text.length + 1)
    if (output && size > 0) {
      const n = Math.min(text.length, size - 1)
      for (let i = 0; i < n; i++) Module.HEAPU8[output + i] = text.charCodeAt(i)
      Module.HEAPU8[output + n] = 0
      if (n < text.length) return ERR_TRUNCATED
    }
    return OK
  }

  function parameterDescription(param, index, output) {
    if (!output) return
    put32(output, guestText(param, "namePointer", param.name))
    putf(output + 4, param.min)
    putf(output + 8, param.max)
    put32(output + 12, param.type)
  }

  function userProperty(description, name, output) {
    const event = description.info ? description.info.event : null
    if (!event || !output) return ERR_EVENT_NOTFOUND
    const lower = name.toLowerCase()
    for (const item of event.numbers) {
      if (item.name.toLowerCase() !== lower) continue
      put32(output, guestText(item, "namePointer", item.name))
      put32(output + 4, 0)
      put32(output + 8, item.value)
      return OK
    }
    for (const item of event.strings) {
      if (item.name.toLowerCase() !== lower) continue
      put32(output, guestText(item, "namePointer", item.name))
      put32(output + 4, 3)
      put32(output + 8, guestText(item, "valuePointer", item.value))
      return OK
    }
    return ERR_EVENT_NOTFOUND
  }

  function studioBus(key) {
    let bus = busObjects.get(key)
    if (!bus) {
      bus = create("bus", {guid: key})
      busObjects.set(key, bus)
    }
    return bus
  }

  function parseFsb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.length < 60 || view.getUint32(0, true) !== 0x35425346) return null
    const count = view.getUint32(8, true)
    const headerBytes = view.getUint32(12, true)
    const nameBytes = view.getUint32(16, true)
    const dataBytes = view.getUint32(20, true)
    const codec = view.getUint32(24, true)
    const start = view.getUint32(4, true) === 0 ? 64 : 60
    let cursor = start
    const samples = []
    for (let index = 0; index < count; index++) {
      const low = view.getUint32(cursor, true)
      const high = view.getUint32(cursor + 4, true)
      cursor += 8
      let more = low & 1
      let frequency = frequencies[(low >>> 1) & 15] || 44100
      let channels = [1, 2, 6, 8][(low >>> 5) & 3]
      while (more) {
        const header = view.getUint32(cursor, true)
        more = header & 1
        const size = (header >>> 1) & 0xffffff
        const type = header >>> 25
        if (type === 1) channels = view.getUint8(cursor + 4)
        if (type === 2) frequency = view.getUint32(cursor + 4, true)
        cursor += 4 + size
      }
      samples.push({codec, frequency, channels, dataOffset: (((low >>> 7) | ((high & 1) << 25)) >>> 0) * 32})
    }
    const dataStart = start + headerBytes + nameBytes
    samples.forEach((sample, index) => {
      const end = index + 1 < samples.length ? samples[index + 1].dataOffset : dataBytes
      sample.data = bytes.subarray(dataStart + sample.dataOffset, dataStart + end)
    })
    return {codec, samples}
  }

  function mpegFrameLength(bytes, at) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return 0
    const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3
    const bitrateIndex = bytes[at + 2] >> 4, rateIndex = (bytes[at + 2] >> 2) & 3, padding = (bytes[at + 2] >> 1) & 1
    if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0
    const mpeg1 = version === 3
    const rates = mpeg1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
    const tables = {
      "1_3": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
      "1_2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
      "1_1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      "2_3": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
      "2_x": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    }
    const key = mpeg1 ? "1_" + layer : layer === 3 ? "2_3" : "2_x"
    const bitrate = tables[key][bitrateIndex] * 1000
    const rate = rates[rateIndex]
    if (layer === 3) return Math.floor(12 * bitrate / rate + padding) * 4
    if (layer === 1 && !mpeg1) return Math.floor(72 * bitrate / rate) + padding
    return Math.floor(144 * bitrate / rate) + padding
  }

  function cleanMpeg(bytes) {
    const out = new Uint8Array(bytes.length)
    let at = 0, used = 0
    while (at + 4 <= bytes.length) {
      const length = mpegFrameLength(bytes, at)
      if (!length || at + length > bytes.length) { at++; continue }
      out.set(bytes.subarray(at, at + length), used)
      used += length
      at += length
    }
    return used ? out.subarray(0, used) : bytes
  }

  function decodeSample(sample, done) {
    if (!decoder) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext
      decoder = Context ? new Context({latencyHint: "interactive"}) : null
    }
    if (!decoder || (sample.codec !== 11 && !sample.encoded)) { sample.failed = true; done(); return }
    const source = sample.encoded || cleanMpeg(sample.data)
    decoder.decodeAudioData(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)).then(buffer => { sample.buffer = buffer }, error => {
      sample.failed = true
      console.warn("[fmod] decode failed, " + source.byteLength + " bytes: " + (error && error.message))
    }).then(done)
  }

  const H = {
    "FMOD_Memory_Initialize": () => OK,
    "FMOD_Memory_GetStats": a => { put32(a[0], 0); put32(a[1], 0); return OK },
    "System.setCallback": () => OK,
    "System.setReverbProperties": () => OK,
    "System.setDriver": () => OK,
    "System.getNumDrivers": a => { put32(a[1], 1); return OK },
    "System.setFileSystem": () => OK,
    "System.getChannel": a => { put32(a[2], 0); return ERR_INVALID_HANDLE },
    "Sound.setUserData": a => { const o = objects.get(a[0]); if (o) o.userData = a[1]; return OK },
    "Sound.getUserData": a => { const o = objects.get(a[0]); put32(a[1], o ? o.userData : 0); return OK },
    "Sound.getSystemObject": a => { put32(a[1], system.handle); return OK },
    "ChannelControl.getUserData": a => { const o = objects.get(a[0]); put32(a[1], o ? o.userData : 0); return OK },
    "ChannelControl.setUserData": a => { const o = objects.get(a[0]); if (o) o.userData = a[1]; return OK },
    "Studio.System.getEventByID": a => { const key = guid(a[1]); if (!M.events.has(key)) { put32(a[2], 0); return ERR_EVENT_NOTFOUND } put32(a[2], describe(key).handle); return OK },
    "Studio.System.getBusByID": a => { put32(a[2], studioBus(guid(a[1])).handle); return OK },
    "Studio.System.lookupPath": a => writePath(guid(a[1]), a[2], a[3] | 0, a[4]),
    "Studio.System.getBankList": a => { const n = Math.min(bankHandles.length, a[2] | 0); for (let i = 0; i < n; i++) put32(a[1] + i * 4, bankHandles[i].handle); put32(a[3], n); return OK },
    "Studio.System.getBankCount": a => { put32(a[1], bankHandles.length); return OK },
    "Studio.System.getSoundInfo": () => ERR_EVENT_NOTFOUND,
    "Studio.Bank.getLoadingState": a => { const o = objects.get(a[0]); put32(a[1], o ? o.state : 1); return OK },
    "Studio.Bank.isValid": a => objects.has(a[0]) ? 1 : 0,
    "Studio.Bank.getBusList": a => { const o = objects.get(a[0]); const list = mixerBuses(o && o.bank); const n = Math.min(list.length, a[2] | 0); for (let i = 0; i < n; i++) put32(a[1] + i * 4, studioBus(list[i]).handle); put32(a[3], n); return OK },
    "Studio.Bank.getBusCount": a => { const o = objects.get(a[0]); put32(a[1], mixerBuses(o && o.bank).length); return OK },
    "Studio.Bank.getEventList": a => { const o = objects.get(a[0]); const list = bankEvents(o && o.bank); const n = Math.min(list.length, a[2] | 0); for (let i = 0; i < n; i++) put32(a[1] + i * 4, describe(list[i]).handle); put32(a[3], n); return OK },
    "Studio.Bank.getEventCount": a => { const o = objects.get(a[0]); put32(a[1], bankEvents(o && o.bank).length); return OK },
    "Studio.EventDescription.isValid": a => objects.has(a[0]) ? 1 : 0,
    "Studio.EventDescription.getID": a => { const d = objects.get(a[0]); if (d) putGuid(a[1], d.guid); return OK },
    "Studio.EventDescription.isOneshot": a => { const d = objects.get(a[0]); put8(a[1], d && d.info ? d.info.oneshot : true); return OK },
    "Studio.EventDescription.is3D": a => { const d = objects.get(a[0]); put8(a[1], d && d.info ? d.info.is3D : false); return OK },
    "Studio.EventDescription.getParameterCount": a => { const d = objects.get(a[0]); put32(a[1], d && d.info ? d.info.params.length : 0); return OK },
    "Studio.EventDescription.getParameterByIndex": a => { const d = objects.get(a[0]); const param = d && d.info ? d.info.params[a[1] | 0] : null; if (!param) return ERR_INVALID_PARAM; parameterDescription(param, a[1] | 0, a[2]); return OK },
    "Studio.EventDescription.getUserProperty": a => { const d = objects.get(a[0]); return d ? userProperty(d, cstring(a[1]), a[2]) : ERR_INVALID_HANDLE },
    "Studio.EventDescription.getLength": a => { const d = objects.get(a[0]); put32(a[1], d && d.info ? Math.round(d.info.length) : 0); return OK },
    "Studio.Bus.getID": a => { const b = objects.get(a[0]); if (b) putGuid(a[1], b.guid); return OK },
    "Studio.Bus.isValid": a => objects.has(a[0]) ? 1 : 0
  }

  function load() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = library
      script.onerror = () => reject(new Error(library + " is missing"))
      script.onload = () => {
        const module = {TOTAL_MEMORY: 128 * 1024 * 1024}
        module.onRuntimeInitialized = () => { FMOD = module; install(); resolve() }
        try { globalThis.FMODModule(module) } catch (error) { reject(error) }
      }
      document.head.appendChild(script)
    })
  }

  function loadRealBank(name, bytes) {
    const file = "bank" + (fileCounter++) + ".bank"
    const o = {}
    try {
      FMOD.FS_createDataFile("/", file, bytes, true, false, true)
      const result = studioSystem.loadBankFile("/" + file, FMOD.STUDIO_LOAD_BANK_NORMAL, o)
      if (result !== OK) { console.warn("[fmod] loadBankFile " + name + " -> " + result + " " + FMOD.ErrorString(result)); return null }
      return {real: o.val, file}
    } catch (error) {
      console.error("[fmod] loadBankFile " + name + " threw " + error)
      return null
    }
  }

  function install() {
    const fl = (a, index) => f32(a.__esp + 4 + index * 4)
    const check = (label, result) => { if (result !== OK) console.warn("[fmod] " + label + " -> " + result + " " + FMOD.ErrorString(result)); return result }
    const real = handle => { const o = objects.get(handle); return o ? o.real : null }
    const setVector = (target, pointer) => { target.x = f32(pointer); target.y = f32(pointer + 4); target.z = f32(pointer + 8) }
    const vector = pointer => { const v = FMOD.VECTOR(); setVector(v, pointer); return v }
    const attributes = pointer => {
      const t = FMOD._3D_ATTRIBUTES()
      setVector(t.position, pointer)
      setVector(t.velocity, pointer + 12)
      setVector(t.forward, pointer + 24)
      setVector(t.up, pointer + 36)
      return t
    }
    const wrap = (kind, object, extra) => create(kind, Object.assign({real: object}, extra))
    const out = () => ({})
    const guard = (label, fn) => (...args) => { try { return fn(...args) } catch (error) { console.error("[fmod] " + label + " threw " + (error && error.message || error)); return OK } }

    const channelControlKinds = new Set(["rchannel", "rgroup"])
    const instanceAlive = o => {
      if (o.dead) return false
      let valid = false
      try { valid = !!o.real.isValid() } catch (error) {}
      if (!valid) o.dead = true
      return valid
    }
    const controlOf = a => { const o = objects.get(a[0]); return o && channelControlKinds.has(o.kind) && (!o.owner || instanceAlive(o.owner)) ? o : null }

    function realDescription(d) {
      if (d.real) return d.real
      const path = paths.get(d.guid)
      if (!path) return null
      const o = out()
      if (check("getEvent " + path, studioSystem.getEvent(path, o)) !== OK) return null
      d.real = o.val
      return d.real
    }

    function realBus(b) {
      if (b.real) return b.real
      const path = paths.get(b.guid)
      if (!path) return null
      const o = out()
      if (check("getBus " + path, studioSystem.getBus(path, o)) !== OK) return null
      b.real = o.val
      return b.real
    }

    function guestString(text) {
      const pointer = Module._malloc(text.length + 1)
      for (let i = 0; i < text.length; i++) Module.HEAPU8[pointer + i] = text.charCodeAt(i)
      Module.HEAPU8[pointer + text.length] = 0
      return pointer
    }

    const guestToReal = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x8, 0x80], [0x10, 0x100], [0x20, 0x200], [0x40, 0x400], [0x80, 0x800], [0x100, 0x1000]]
    const realMask = guestMask => {
      let mask = 0
      for (const [guest, real] of guestToReal) if (guestMask & guest) mask |= real
      return mask >>> 0
    }
    const guestType = realType => { for (const [guest, real] of guestToReal) if (real === realType) return guest; return 0 }

    function dispatchEvent(owner, realType, parameters) {
      const type = guestType(realType)
      if (!type || !owner.callbackPointer || !(owner.callbackMask & type)) return OK
      if (type === 0x8) {
        const name = parameters && parameters.name ? String(parameters.name) : ""
        const props = Module._malloc(16)
        put32(props, guestString(name))
        put32(props + 4, 0)
        put32(props + 8, 0xffffffff)
        owner.programmerProps = props
        callbacks.push([owner.callbackPointer, type, owner.handle, props])
        Module._mcsm_fmod_pump()
        const soundHandle = u32(props + 4)
        const sound = objects.get(soundHandle)
        const index = i32(props + 8)
        let target = null
        let subsound = -1
        if (sound && sound.pcmSubs) {
          const chosen = sound.pcmSubs[index >= 0 ? index : 0] || sound.pcmSubs.find(Boolean)
          target = chosen ? chosen.real : null
        } else if (sound && sound.real) {
          target = sound.real
          subsound = index
          if (index >= 0) { const sub = out(); if (sound.real.getSubSound(index, sub) === OK) target = sub.val }
        }
        if (!target) target = silentSound()
        parameters.sound = target
        parameters.subsoundIndex = subsound
        return OK
      }
      if (type === 0x10) {
        const props = owner.programmerProps || 0
        callbacks.push([owner.callbackPointer, type, owner.handle, props])
        Module._mcsm_fmod_pump()
        if (props) { Module._free(u32(props)); Module._free(props) }
        owner.programmerProps = 0
        return OK
      }
      if (type & (0x1 | 0x2 | 0x4)) callbacks.push([owner.callbackPointer, type, owner.handle, 0])
      return OK
    }

    function pcmSound(buffer, mode) {
      const channels = buffer.numberOfChannels
      const frames = buffer.length
      const samples = new Int16Array(frames * channels)
      for (let channel = 0; channel < channels; channel++) {
        const input = buffer.getChannelData(channel)
        for (let frame = 0; frame < frames; frame++) {
          const value = Math.round(input[frame] * 32767)
          samples[frame * channels + channel] = value > 32767 ? 32767 : value < -32768 ? -32768 : value
        }
      }
      const file = "pcm" + (fileCounter++) + ".raw"
      FMOD.FS_createDataFile("/", file, new Uint8Array(samples.buffer), true, false, true)
      const info = FMOD.CREATESOUNDEXINFO()
      info.length = samples.byteLength
      info.numchannels = channels
      info.defaultfrequency = buffer.sampleRate
      info.format = FMOD.SOUND_FORMAT_PCM16
      const o = out()
      const keep = mode & (0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x40000 | 0x80000 | 0x100000 | 0x200000 | 0x400000)
      const result = lowSystem.createSound("/" + file, FMOD.OPENRAW | FMOD.CREATESAMPLE | keep, info, o)
      if (check("createSound pcm", result) !== OK) { try { FMOD.FS_unlink("/" + file) } catch (error) {} return null }
      return wrap("rsound", o.val, {file, userData: 0})
    }

    let silence = null
    function silentSound() {
      if (!silence) silence = pcmSound({numberOfChannels: 1, length: 2205, sampleRate: 22050, getChannelData: () => new Float32Array(2205)}, 0)
      return silence ? silence.real : null
    }

    const sharedEventCallback = (type, instance, parameters) => {
      try {
        const o = out()
        const got = instance.getUserData(o)
        const owner = got === OK ? objects.get(o.val) : null
        if (owner && type === 0x20) owner.stoppedSeen = true
        if (owner && type === 0x80) owner.programmerLive = (owner.programmerLive || 0) + 1
        if (owner && type === 0x100) owner.programmerLive = Math.max(0, (owner.programmerLive || 0) - 1)
        return owner ? dispatchEvent(owner, type, parameters) : OK
      } catch (error) {
        console.error("[fmod] event callback type=" + type + " threw " + (error && error.stack || error))
        return OK
      }
    }

    H["Studio.System.create"] = a => {
      const o = out()
      check("Studio_System_Create", FMOD.Studio_System_Create(o))
      studioSystem = o.val
      check("getLowLevelSystem", studioSystem.getLowLevelSystem(o))
      lowSystem = o.val
      studio.real = studioSystem
      system.real = lowSystem
      put32(a[0], studio.handle)
      return OK
    }
    H["Studio.System.initialize"] = a => {
      const o = out()
      lowSystem.setDSPBufferSize(2048, 2)
      try {
        const advanced = FMOD.ADVANCEDSETTINGS()
        advanced.vol0virtualvol = -1
        check("setAdvancedSettings", lowSystem.setAdvancedSettings(advanced))
      } catch (error) { console.error("[fmod] advanced settings threw " + (error && error.message || error)) }
      if (lowSystem.getDriverInfo(0, null, null, o, null, null) === OK) lowSystem.setSoftwareFormat(o.val, FMOD.SPEAKERMODE_DEFAULT, 0)
      return check("initialize", studioSystem.initialize(Math.max(a[1] | 0, 128), FMOD.STUDIO_INIT_NORMAL, FMOD.INIT_NORMAL, null))
    }
    H["Studio.System.getLowLevelSystem"] = a => { put32(a[1], system.handle); return OK }
    H["Studio.System.release"] = () => OK
    let updateReported = false
    const pendingRelease = new Set()
    H["Studio.System.update"] = () => {
      if (!studioSystem) return OK
      if (pendingRelease.size) {
        for (const o of pendingRelease) {
          let valid = false
          try { valid = !!o.real.isValid() } catch (error) {}
          if (valid && (!o.stoppedSeen || o.programmerLive > 0)) continue
          pendingRelease.delete(o)
          try { if (valid) o.real.release() } catch (error) {}
        }
      }
      try { return studioSystem.update() } catch (error) {
        if (!updateReported) { updateReported = true; console.error("[fmod] update threw " + (error && error.stack || error)) }
        return OK
      }
    }
    H["Studio.System.flushCommands"] = () => studioSystem ? studioSystem.flushCommands() : OK
    H["Studio.System.setListenerAttributes"] = guard("setListenerAttributes", a => a[2] ? studioSystem.setListenerAttributes(a[1] | 0, attributes(a[2])) : OK)
    H["System.getVersion"] = a => { put32(a[1], 0x00011020); return OK }
    H["System.getSoftwareFormat"] = a => { const rate = out(); lowSystem.getSoftwareFormat(rate, null, null); put32(a[1], rate.val); put32(a[2], 3); put32(a[3], 0); return OK }
    H["System.setSoftwareFormat"] = () => OK
    H["System.mixerResume"] = () => lowSystem ? lowSystem.mixerResume() : OK
    H["System.mixerSuspend"] = () => lowSystem ? lowSystem.mixerSuspend() : OK

    H["System.getMasterChannelGroup"] = a => {
      if (!masterGroupHandle) {
        const o = out()
        if (check("getMasterChannelGroup", lowSystem.getMasterChannelGroup(o)) !== OK) return ERR_INVALID_HANDLE
        masterGroupHandle = wrap("rgroup", o.val)
      }
      put32(a[1], masterGroupHandle.handle)
      return OK
    }
    H["System.createChannelGroup"] = a => {
      const o = out()
      const result = lowSystem.createChannelGroup(a[1] ? cstring(a[1]) : "", o)
      if (result !== OK) return result
      put32(a[2], wrap("rgroup", o.val).handle)
      return OK
    }
    H["System.createDSPByType"] = a => {
      const o = out()
      const result = lowSystem.createDSPByType(a[1] | 0, o)
      if (result !== OK) return result
      put32(a[2], wrap("rdsp", o.val).handle)
      return OK
    }

    H["System.createSound"] = a => {
      const mode = a[2], exinfo = a[3]
      let bytes = null
      if (mode & (0x800 | 0x10000000)) {
        const length = exinfo ? u32(exinfo + 4) : 0
        bytes = Module.HEAPU8.slice(a[1], a[1] + length)
      } else if (!(mode & 0x400)) {
        bytes = pendingFile ? pendingFile.subarray(0, pendingAt) : null
        pendingFile = null
      }
      const nonblock = exinfo && u32(exinfo) >= 56 ? u32(exinfo + 52) : 0
      const userData = exinfo && u32(exinfo) >= 72 ? u32(exinfo + 68) : 0
      const finish = (soundHandle, result) => { if (nonblock) callbacks.push([nonblock, soundHandle, result]) }
      if (!bytes || !bytes.length) {
        const dead = create("rsound", {real: null, userData, failed: true})
        put32(a[4], dead.handle)
        finish(dead.handle, 18)
        return OK
      }
      const fsb = bytes.length > 28 && bytes[0] === 0x46 && bytes[1] === 0x53 && bytes[2] === 0x42 ? parseFsb(bytes) : null
      const decoded = !fsb || fsb.samples.some(sample => sample.codec === 11)
      if (decoded) {
        const sound = create("rsound", {real: null, userData, pending: true, failed: false, pcmSubs: []})
        const samples = fsb ? fsb.samples : [{codec: 11, encoded: bytes}]
        let remaining = samples.length
        samples.forEach((sample, index) => {
          let finished = false
          const done = () => {
            if (finished) return
            finished = true
            if (!sample.failed && sample.buffer) sound.pcmSubs[index] = pcmSound(sample.buffer, mode)
            if (--remaining > 0) return
            const first = sound.pcmSubs.find(Boolean)
            sound.real = first ? first.real : null
            sound.pending = false
            sound.failed = !sound.real
            finish(sound.handle, sound.failed ? 19 : OK)
          }
          decodeSample(sample, done)
        })
        put32(a[4], sound.handle)
        return OK
      }
      const file = "snd" + (fileCounter++) + ".fsb"
      FMOD.FS_createDataFile("/", file, bytes, true, false, true)
      const flags = mode & ~(0x800 | 0x10000000 | 0x400 | 0x10000 | 0x2000)
      const o = out()
      const result = lowSystem.createSound("/" + file, flags, null, o)
      if (result !== OK) {
        check("createSound", result)
        try { FMOD.FS_unlink("/" + file) } catch (error) {}
        const dead = create("rsound", {real: null, userData, failed: true})
        put32(a[4], dead.handle)
        finish(dead.handle, result)
        return OK
      }
      const sound = wrap("rsound", o.val, {userData, file})
      put32(a[4], sound.handle)
      finish(sound.handle, OK)
      return OK
    }
    H["System.playSound"] = guard("playSound", a => {
      const sound = objects.get(a[1])
      if (!sound || !sound.real) return ERR_INVALID_HANDLE
      if (sound.pending) return 18
      const group = objects.get(a[2])
      const o = out()
      const result = lowSystem.playSound(sound.real, group && group.real ? group.real : null, !!(a[3] & 255), o)
      if (result !== OK) return result
      put32(a[4], wrap("rchannel", o.val, {sound}).handle)
      return OK
    })

    const releaseSound = o => {
      if (o.real) { try { o.real.release() } catch (error) {} }
      if (o.file) { try { FMOD.FS_unlink("/" + o.file) } catch (error) {} }
    }
    H["Sound.release"] = a => {
      const o = objects.get(a[0])
      if (o) {
        if (o.pcmSubs) { for (const sub of o.pcmSubs) if (sub) releaseSound(sub) } else releaseSound(o)
        if (o.subs) for (const sub of o.subs.values()) objects.delete(sub.handle)
      }
      objects.delete(a[0])
      return OK
    }
    H["Sound.getOpenState"] = a => {
      const o = objects.get(a[0])
      put32(a[1], o && o.pending ? 1 : !o || o.failed ? 2 : 0)
      put32(a[2], o && o.pending ? 50 : 100)
      put8(a[3], 0)
      put8(a[4], 0)
      return OK
    }
    H["Sound.getSubSound"] = a => {
      const o = objects.get(a[0])
      if (o && o.pcmSubs) {
        const sub = o.pcmSubs[a[1] | 0]
        put32(a[2], sub ? sub.handle : 0)
        return sub ? OK : ERR_INVALID_HANDLE
      }
      if (!o || !o.real) return ERR_INVALID_HANDLE
      o.subs = o.subs || new Map()
      let sub = o.subs.get(a[1])
      if (!sub) {
        const r = out()
        const result = o.real.getSubSound(a[1] | 0, r)
        if (result !== OK) { put32(a[2], 0); return result }
        sub = wrap("rsound", r.val, {userData: o.userData})
        o.subs.set(a[1], sub)
      }
      put32(a[2], sub.handle)
      return OK
    }
    H["Sound.getNumSubSounds"] = a => {
      const o = objects.get(a[0])
      if (o && o.pcmSubs) { put32(a[1], o.pcmSubs.length); return OK }
      if (!o || !o.real) { put32(a[1], 0); return OK }
      const r = out()
      const result = o.real.getNumSubSounds(r)
      put32(a[1], result === OK ? r.val : 0)
      return OK
    }
    H["Sound.getLength"] = a => {
      const o = objects.get(a[0])
      if (!o || !o.real) { put32(a[1], 0); return OK }
      const r = out()
      const result = o.real.getLength(r, a[2] | 0)
      put32(a[1], result === OK ? r.val : 0)
      return OK
    }
    H["Sound.getNumSyncPoints"] = a => { put32(a[1], 0); return OK }
    H["Sound.getLoopPoints"] = a => {
      const o = objects.get(a[0])
      const r = out()
      if (o && o.real && o.real.getLength(r, a[4] | 0) === OK) { put32(a[1], 0); put32(a[3], Math.max(0, r.val - 1)) } else { put32(a[1], 0); put32(a[3], 0) }
      return OK
    }

    H["ChannelControl.stop"] = a => { const o = controlOf(a); return o ? o.real.stop() : OK }
    H["ChannelControl.getAudibility"] = a => { const o = controlOf(a); const r = out(); if (o && o.real.getAudibility(r) === OK) putf(a[1], r.val); else putf(a[1], 1); return OK }
    H["ChannelControl.set3DAttributes"] = guard("set3DAttributes", a => { const o = controlOf(a); if (!o || !a[1]) return OK; return o.real.set3DAttributes(vector(a[1]), a[2] ? vector(a[2]) : null) })
    H["ChannelControl.setVolume"] = a => { const o = controlOf(a); return o ? o.real.setVolume(fl(a, 1)) : OK }
    H["ChannelControl.getVolume"] = a => { const o = controlOf(a); const r = out(); if (o && o.real.getVolume(r) === OK) putf(a[1], r.val); else putf(a[1], 1); return OK }
    H["ChannelControl.setPan"] = a => { const o = controlOf(a); return o ? o.real.setPan(fl(a, 1)) : OK }
    H["ChannelControl.setPitch"] = a => { const o = controlOf(a); return o ? o.real.setPitch(fl(a, 1)) : OK }
    H["ChannelControl.set3DMinMaxDistance"] = a => { const o = controlOf(a); return o ? o.real.set3DMinMaxDistance(fl(a, 1), fl(a, 2)) : OK }
    H["ChannelControl.get3DMinMaxDistance"] = a => { const o = controlOf(a); const lo = out(), hi = out(); if (o && o.real.get3DMinMaxDistance(lo, hi) === OK) { putf(a[1], lo.val); putf(a[2], hi.val) } else { putf(a[1], 1); putf(a[2], 10000) } return OK }
    H["ChannelControl.setPaused"] = a => { const o = controlOf(a); return o ? o.real.setPaused(!!(a[1] & 255)) : OK }
    H["ChannelControl.setMode"] = a => { const o = controlOf(a); return o ? o.real.setMode(a[1] >>> 0) : OK }
    H["ChannelControl.setCallback"] = guard("channel setCallback", a => {
      const o = controlOf(a)
      if (!o) return OK
      o.callbackPointer = a[1]
      return o.real.setCallback((control, controlType, callbackType) => {
        if (callbackType === 0 && o.callbackPointer) callbacks.push([o.callbackPointer, o.handle, controlType, 0, 0, 0])
        return OK
      })
    })
    H["ChannelControl.isPlaying"] = a => { const o = controlOf(a); const r = out(); put8(a[1], o && o.kind === "rchannel" && o.real.isPlaying(r) === OK ? r.val : false); return OK }
    H["ChannelControl.getSystemObject"] = a => { put32(a[1], system.handle); return OK }
    H["ChannelControl.addDSP"] = guard("addDSP", a => { const o = controlOf(a); const d = objects.get(a[2]); return o && d && d.real ? o.real.addDSP(a[1] | 0, d.real) : OK })
    H["ChannelControl.getDSP"] = guard("getDSP", a => { const o = controlOf(a); const r = out(); if (o && o.real.getDSP(a[1] | 0, r) === OK) put32(a[2], wrap("rdsp", r.val).handle); else put32(a[2], 0); return OK })
    H["ChannelControl.setReverbProperties"] = guard("channel reverb", a => { const o = controlOf(a); return o ? o.real.setReverbProperties(a[1] | 0, fl(a, 2)) : OK })
    H["ChannelControl.setMute"] = a => { const o = controlOf(a); return o ? o.real.setMute(!!(a[1] & 255)) : OK }
    H["Channel.getCurrentSound"] = a => { const o = objects.get(a[0]); put32(a[1], o && o.sound ? o.sound.handle : 0); return OK }
    H["Channel.setPosition"] = a => { const o = controlOf(a); return o ? o.real.setPosition(a[1] >>> 0, a[2] | 0) : OK }
    H["Channel.getPosition"] = a => { const o = controlOf(a); const r = out(); put32(a[1], o && o.real.getPosition(r, a[2] | 0) === OK ? r.val : 0); return OK }
    H["Channel.setLoopCount"] = a => { const o = controlOf(a); return o ? o.real.setLoopCount(a[1] | 0) : OK }
    H["Channel.getChannelGroup"] = a => { const o = controlOf(a); const r = out(); if (o && o.real.getChannelGroup(r) === OK) put32(a[1], wrap("rgroup", r.val).handle); else put32(a[1], masterGroupHandle ? masterGroupHandle.handle : 0); return OK }
    H["Channel.setChannelGroup"] = a => { const o = controlOf(a); const g = objects.get(a[1]); return o && g && g.real ? o.real.setChannelGroup(g.real) : OK }
    H["ChannelGroup.getChannel"] = a => { const o = controlOf(a); const r = out(); if (o && o.real.getChannel(a[1] | 0, r) === OK) { put32(a[2], wrap("rchannel", r.val, {owner: o.owner}).handle); return OK } put32(a[2], 0); return ERR_INVALID_HANDLE }
    H["ChannelGroup.getNumChannels"] = a => { const o = controlOf(a); const r = out(); put32(a[1], o && o.real.getNumChannels(r) === OK ? r.val : 0); return OK }
    H["ChannelGroup.getGroup"] = a => { const o = controlOf(a); const r = out(); if (o && o.real.getGroup(a[1] | 0, r) === OK) { put32(a[2], wrap("rgroup", r.val, {owner: o.owner}).handle); return OK } put32(a[2], 0); return ERR_INVALID_HANDLE }
    H["ChannelGroup.getNumGroups"] = a => { const o = controlOf(a); const r = out(); put32(a[1], o && o.real.getNumGroups(r) === OK ? r.val : 0); return OK }
    H["ChannelGroup.release"] = a => { const o = controlOf(a); if (o) { try { o.real.release() } catch (error) {} } return OK }
    H["ChannelGroup.addGroup"] = guard("addGroup", a => { const o = controlOf(a); const child = objects.get(a[1]); put32(a[3], 0); return o && child && child.real ? o.real.addGroup(child.real, !!(a[2] & 255), null) : OK })
    H["DSP.setParameterFloat"] = a => { const o = objects.get(a[0]); return o && o.real ? o.real.setParameterFloat(a[1] | 0, fl(a, 2)) : OK }
    H["DSP.setParameterInt"] = a => { const o = objects.get(a[0]); return o && o.real ? o.real.setParameterInt(a[1] | 0, a[2] | 0) : OK }
    H["DSP.release"] = a => { const o = objects.get(a[0]); if (o && o.real) { try { o.real.release() } catch (error) {} } return OK }
    H["DSP.setChannelFormat"] = a => { const o = objects.get(a[0]); return o && o.real ? o.real.setChannelFormat(a[1] >>> 0, a[2] | 0, a[3] | 0) : OK }

    H["Studio.Bank.unload"] = a => {
      const o = objects.get(a[0])
      if (!o) return OK
      if (o.real) {
        try { o.real.unload() } catch (error) {}
        try { FMOD.FS_unlink("/" + o.file) } catch (error) {}
        o.real = null
      }
      o.state = 1
      const index = bankHandles.indexOf(o)
      if (index >= 0) bankHandles.splice(index, 1)
      return OK
    }

    H["Studio.EventDescription.loadSampleData"] = guard("loadSampleData", a => { const d = objects.get(a[0]); const r = d ? realDescription(d) : null; return r ? r.loadSampleData() : OK })
    H["Studio.EventDescription.unloadSampleData"] = guard("unloadSampleData", a => { const d = objects.get(a[0]); const r = d ? realDescription(d) : null; return r ? r.unloadSampleData() : OK })
    H["Studio.EventDescription.getSampleLoadingState"] = guard("sampleLoadingState", a => { const d = objects.get(a[0]); const r = d ? realDescription(d) : null; const o = out(); if (r && r.getSampleLoadingState(o) === OK) put32(a[1], o.val); else put32(a[1], 3); return OK })
    H["Studio.EventDescription.createInstance"] = a => {
      const d = objects.get(a[0])
      const r = d ? realDescription(d) : null
      if (!r) return ERR_INVALID_HANDLE
      const o = out()
      const result = r.createInstance(o)
      if (result !== OK) return result
      const instance = wrap("rinstance", o.val, {description: d, callbackPointer: 0, programmerProps: 0})
      put32(a[1], instance.handle)
      return OK
    }

    const instanceOf = a => { const o = objects.get(a[0]); return o && o.kind === "rinstance" ? o : null }
    H["Studio.EventInstance.set3DAttributes"] = guard("instance set3D", a => { const o = instanceOf(a); return o && a[1] ? o.real.set3DAttributes(attributes(a[1])) : OK })
    H["Studio.EventInstance.isValid"] = a => { const o = instanceOf(a); return o && instanceAlive(o) ? 1 : 0 }
    H["Studio.EventInstance.setVolume"] = a => { const o = instanceOf(a); if (!o) return OK; o.volume = fl(a, 1); return o.cutting ? OK : o.real.setVolume(o.volume) }
    H["Studio.EventInstance.setPaused"] = a => { const o = instanceOf(a); return o && !o.cutting ? o.real.setPaused(!!(a[1] & 255)) : OK }
    H["Studio.EventInstance.stop"] = a => {
      const o = instanceOf(a)
      if (!o) return OK
      if ((a[1] | 0) !== 1 || !(o.programmerLive > 0)) return o.real.stop(a[1] | 0)
      o.cutting = true
      o.real.setVolume(0)
      o.real.setPaused(false)
      return o.real.stop(0)
    }
    H["Studio.EventInstance.start"] = a => {
      const o = instanceOf(a)
      if (!o) return OK
      o.playing = true
      o.stoppedSeen = false
      if (o.cutting) { o.cutting = false; o.real.setVolume(o.volume === undefined ? 1 : o.volume) }
      return o.real.start()
    }
    H["Studio.EventInstance.release"] = a => {
      const o = instanceOf(a)
      if (!o || o.released) return OK
      o.released = true
      if (!instanceAlive(o)) return OK
      if (!o.callbackPointer || !o.playing || (o.stoppedSeen && !(o.programmerLive > 0))) return o.real.release()
      pendingRelease.add(o)
      return OK
    }
    H["Studio.EventInstance.getPlaybackState"] = a => { const o = instanceOf(a); const r = out(); put32(a[1], o && o.real.getPlaybackState(r) === OK ? r.val : 2); return OK }
    H["Studio.EventInstance.getChannelGroup"] = a => {
      const o = instanceOf(a)
      if (!o || !instanceAlive(o)) return ERR_INVALID_HANDLE
      if (!o.group) {
        const r = out()
        const result = o.real.getChannelGroup(r)
        if (result !== OK) return result
        o.group = wrap("rgroup", r.val, {owner: o})
      }
      put32(a[1], o.group.handle)
      return OK
    }
    H["Studio.EventInstance.getUserData"] = a => { const o = instanceOf(a); put32(a[1], o ? o.userData : 0); return OK }
    H["Studio.EventInstance.setUserData"] = a => { const o = instanceOf(a); if (o) o.userData = a[1]; return OK }
    H["Studio.EventInstance.getParameterCount"] = a => { const o = instanceOf(a); const r = out(); put32(a[1], o && o.real.getParameterCount(r) === OK ? r.val : 0); return OK }
    const parameterOf = (o, key, fetch) => {
      o.parameters = o.parameters || new Map()
      let entry = o.parameters.get(key)
      if (!entry) {
        const r = out()
        const result = fetch(r)
        entry = {result, handle: result === OK ? wrap("rparameter", r.val, {instance: o}).handle : 0}
        o.parameters.set(key, entry)
      }
      return entry
    }
    H["Studio.EventInstance.getParameterByIndex"] = a => {
      const o = instanceOf(a)
      if (!o) { put32(a[2], 0); return 31 }
      const index = a[1] | 0
      const entry = parameterOf(o, index, r => o.real.getParameterByIndex(index, r))
      put32(a[2], entry.handle)
      return entry.result === OK ? OK : 31
    }
    H["Studio.EventInstance.getParameter"] = a => {
      const o = instanceOf(a)
      if (!o) return ERR_INVALID_HANDLE
      const name = cstring(a[1])
      const entry = parameterOf(o, "n:" + name.toLowerCase(), r => o.real.getParameter(name, r))
      put32(a[2], entry.handle)
      return entry.result
    }
    H["Studio.EventInstance.getCueByIndex"] = a => {
      const o = instanceOf(a)
      if (a[2]) put32(a[2], 0)
      if (!o) return ERR_INVALID_HANDLE
      if ((a[1] | 0) !== 0) return ERR_EVENT_NOTFOUND
      if (o.cue === undefined) {
        o.cue = null
        try {
          const description = o.description ? realDescription(o.description) : null
          const r = out()
          if (description && description.hasCue(r) === OK && r.val) o.cue = create("rcue", {instance: o})
        } catch (error) {
          console.error("[fmod] hasCue threw " + (error && error.message || error))
        }
      }
      if (!o.cue) return ERR_EVENT_NOTFOUND
      if (a[2]) put32(a[2], o.cue.handle)
      return OK
    }
    H["Studio.EventInstance.setTimelinePosition"] = a => { const o = instanceOf(a); return o ? o.real.setTimelinePosition(a[1] | 0) : OK }
    H["Studio.EventInstance.getTimelinePosition"] = a => { const o = instanceOf(a); const r = out(); put32(a[1], o && o.real.getTimelinePosition(r) === OK ? r.val : 0); return OK }
    H["Studio.EventInstance.setCallback"] = guard("instance setCallback", a => {
      const o = instanceOf(a)
      if (!o) return OK
      o.callbackPointer = a[1]
      o.callbackMask = a[2] >>> 0
      o.real.setUserData(o.handle)
      return o.real.setCallback(sharedEventCallback, ((realMask(a[2]) & 0x1B8) | 0x20) >>> 0)
    })
    H["Studio.CueInstance.trigger"] = a => { const o = objects.get(a[0]); return o && o.instance && o.instance.real ? o.instance.real.triggerCue() : OK }
    H["Studio.ParameterInstance.setValue"] = a => { const o = objects.get(a[0]); return o && o.real ? o.real.setValue(fl(a, 1)) : OK }
    H["Studio.ParameterInstance.getValue"] = a => { const o = objects.get(a[0]); const r = out(); putf(a[1], o && o.real.getValue(r) === OK ? r.val : 0); return OK }
    H["Studio.ParameterInstance.getDescription"] = a => {
      const o = objects.get(a[0])
      if (!o || !o.real) return ERR_INVALID_HANDLE
      const description = FMOD.STUDIO_PARAMETER_DESCRIPTION()
      const result = o.real.getDescription(description)
      if (result !== OK) return result
      o.param = o.param || {name: description.name, min: description.minimum, max: description.maximum, type: description.type, def: description.defaultvalue}
      parameterDescription(o.param, description.index, a[1])
      return OK
    }
    H["Studio.ParameterInstance.isValid"] = a => objects.has(a[0]) ? 1 : 0

    H["Studio.Bus.lockChannelGroup"] = guard("bus lock", a => { const b = objects.get(a[0]); const r = b ? realBus(b) : null; return r ? r.lockChannelGroup() : OK })
    H["Studio.Bus.unlockChannelGroup"] = guard("bus unlock", a => { const b = objects.get(a[0]); const r = b ? realBus(b) : null; return r ? r.unlockChannelGroup() : OK })
    H["Studio.Bus.getChannelGroup"] = guard("bus group", a => {
      const b = objects.get(a[0])
      const r = b ? realBus(b) : null
      const o = out()
      if (r && r.getChannelGroup(o) === OK) { put32(a[1], wrap("rgroup", o.val).handle); return OK }
      put32(a[1], masterGroupHandle ? masterGroupHandle.handle : masterGroup.handle)
      return OK
    })
    H["Studio.Bus.setPaused"] = a => { const b = objects.get(a[0]); const r = b ? realBus(b) : null; return r ? r.setPaused(!!(a[1] & 255)) : OK }
    H["Studio.Bus.setMute"] = a => { const b = objects.get(a[0]); const r = b ? realBus(b) : null; return r ? r.setMute(!!(a[1] & 255)) : OK }
    H["Studio.Bus.setFaderLevel"] = a => { const b = objects.get(a[0]); const r = b ? realBus(b) : null; return r ? r.setVolume(fl(a, 1)) : OK }
  }

  return {
    objects,
    paths,
    load,
    bind,
    call(index, esp) {
      const name = names[index] || ""
      const handler = H[name]
      const args = new Array(12)
      for (let i = 0; i < 12; i++) args[i] = u32(esp + 4 + i * 4)
      args.__esp = esp
      if (!handler) {
        if (/\.isValid$/.test(name)) return objects.has(args[0]) ? 1 : 0
        if (!unknown.has(name)) { unknown.add(name); console.warn("[fmod] unhandled " + name) }
        return OK
      }
      try { return handler(args) >>> 0 } catch (error) { console.error("[fmod] " + name + " failed " + (error.stack || error.message)); return OK }
    },
    bankChunk(data, size, total) {
      if (!size) { pendingFile = new Uint8Array(total); pendingAt = 0; return }
      if (!pendingFile) return
      const n = Math.min(size, pendingFile.length - pendingAt)
      pendingFile.set(Module.HEAPU8.subarray(data, data + n), pendingAt)
      pendingAt += n
    },
    bankLoaded(output, data, size, namePointer) {
      const name = namePointer ? cstring(namePointer) : ""
      const bytes = size && pendingFile ? pendingFile.subarray(0, size) : new Uint8Array()
      pendingFile = null
      let model = null
      try { model = parseBank(bytes) } catch (error) { console.error("[fmod] bank parse failed " + name + " " + error.message) }
      if (!model) model = parseBank(new Uint8Array())
      mergeModel(model)
      const loaded = bytes.length ? loadRealBank(name, bytes) : null
      const handle = create("bank", {bank: {name, model}, state: 3, real: loaded ? loaded.real : null, file: loaded ? loaded.file : ""})
      bankHandles.push(handle)
      put32(output, handle.handle)
    },
    nextCallback(output) {
      const entry = callbacks.shift()
      if (!entry) return 0
      put32(output, entry[0])
      for (let i = 1; i < entry.length; i++) put32(output + i * 4, entry[i])
      return entry.length - 1
    }
  }
})()
