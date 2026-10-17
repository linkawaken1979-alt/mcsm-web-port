globalThis.MCSMFiles = {
  entries: new Map(),
  handles: new Map(),
  nextHandle: 256,
  cwd: "",
  blockSize: 262144,
  blockLimit: 4096,
  blockCache: new Map(),
  record: typeof location !== "undefined" && /[?&]recordblocks\b/.test(location.search) ? new Map() : null,
  coverage: typeof location !== "undefined" && /[?&]coverage\b/.test(location.search) ? { bytes: 0, reads: 0, pages: new Set() } : null,
  blockHits: 0,
  blockMisses: 0,
  source: "game.data",
  partSize: 20 * 1024 * 1024,
  partCount: 324,
  partCache: new Map(),
  partPending: new Map(),
  totalSize: null,

  async getPart(index) {
    if (index < 0 || index >= this.partCount) throw new Error(`Invalid game.data part ${index}`);

    if (this.partCache.has(index)) return this.partCache.get(index);
    if (this.partPending.has(index)) return this.partPending.get(index);

    const promise = (async () => {
      const name = `game.data.part${String(index).padStart(3, "0")}`;
      const response = await fetch(`game-files/${name}`, { cache: "force-cache" });

      if (!response.ok) throw new Error(`${name} failed: HTTP ${response.status}`);

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > this.partSize) throw new Error(`${name} exceeds 20 MiB`);

      this.partCache.set(index, bytes);

      // Keep only a few parts in memory to avoid retaining the entire game.
      while (this.partCache.size > 3) {
        const oldest = this.partCache.keys().next().value;
        if (oldest === index && this.partCache.size > 1) {
          const keys = Array.from(this.partCache.keys());
          this.partCache.delete(keys[0]);
        } else {
          this.partCache.delete(oldest);
        }
      }

      return bytes;
    })();

    this.partPending.set(index, promise);

    try {
      return await promise;
    } finally {
      this.partPending.delete(index);
    }
  },

  async getTotalSize() {
    if (this.totalSize !== null) return this.totalSize;

    const last = await this.getPart(this.partCount - 1);
    this.totalSize = (this.partCount - 1) * this.partSize + last.length;
    return this.totalSize;
  },

  async slice(start, size, short = false) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0) {
      throw new Error("Invalid game.data byte range");
    }

    const total = await this.getTotalSize();

    if (start >= total || size === 0) {
      if (short) return new Uint8Array();
      throw new Error("game.data range is outside the file");
    }

    const wanted = Math.min(size, total - start);
    if (!short && wanted !== size) throw new Error("game.data is incomplete");

    const output = new Uint8Array(wanted);
    let position = start;
    let written = 0;

    while (written < wanted) {
      const partIndex = Math.floor(position / this.partSize);
      const partOffset = position - partIndex * this.partSize;
      const part = await this.getPart(partIndex);
      const available = Math.min(part.length - partOffset, wanted - written);

      if (available <= 0) throw new Error(`Incomplete game.data part ${partIndex}`);

      output.set(part.subarray(partOffset, partOffset + available), written);
      position += available;
      written += available;
    }

    return output;
  },

  async whole(path) {
    const entry = this.resolve(path);
    if (!entry || entry.directory) throw new Error(`${path} is not in game.data`);

    if (entry.arriving) {
      await entry.arriving.catch(() => { });
      entry.arriving = null;
    }

    const held = entry.held;
    entry.held = null;

    return held || entry.bytes || this.slice(entry.offset, entry.size);
  },

  normalize(path) {
    let result = path.replace(/\\/g, "/").replace(/^\/{2}\?\//, "").replace(/^[a-z]:(?:\.\/|\/)?/i, "").replace(/^\/+/, "");
    result = result.replace(/^.*?MinecraftStoryMode\//i, "");

    const parts = [];
    for (const part of result.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }

    return parts.join("/").toLowerCase();
  },

  async init() {
    const memory = typeof navigator !== "undefined" && navigator.deviceMemory ? navigator.deviceMemory : 8;
    this.blockLimit = memory <= 2 ? 512 : memory <= 4 ? 1024 : 6144;

    const head = await this.slice(0, this.blockSize, true);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

    if (head.length < 32 || new TextDecoder().decode(head.subarray(0, 8)) !== "MCSMDATA" || view.getUint32(8, true) !== 1) {
      throw new Error("game.data is not a package this page can read");
    }

    const listed = view.getUint32(16, true) + view.getUint32(20, true) * 4294967296;
    const length = view.getUint32(24, true);
    const indexBytes = listed + length <= head.length ? head.subarray(listed, listed + length) : await this.slice(listed, length);
    const index = JSON.parse(new TextDecoder().decode(indexBytes));

    const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
    const hidden = (query.get("hide") || "").toLowerCase();
    const overlay = query.get("overlay") !== "off";

    this.entries.set("", { path: "", size: 0, directory: true });
    for (const path of index.directories) {
      this.entries.set(this.normalize(path), { path, size: 0, directory: true });
    }

    const preloaded = [];
    let start = Infinity;
    let end = 0;

    for (const entry of index.files) {
      const key = this.normalize(entry.path);
      const early = /^archives\/_res.*\.lua$/.test(key);

      if (early) {
        start = Math.min(start, entry.offset);
        end = Math.max(end, entry.offset + entry.size);
      }

      if ((hidden && key.includes(hidden)) || (entry.overlay && !overlay)) continue;

      entry.directory = false;
      this.entries.set(key, entry);
      if (early) preloaded.push(entry);
    }

    await this.begin(index, preloaded, start, end);
    this.restore();
  },

  async begin(index, preloaded, start, end) {
    const size = this.blockSize;
    const groups = (index.groups || []).filter(group => group.blockSize === size);

    for (const group of groups) {
      group.items = [];
      group.size = 0;
      group.read = 0;

      const add = (entry, first, count) => {
        const known = this.entries.get(this.normalize(entry.path)) === entry;

        for (let block = first; block < first + count && block * size < entry.size; block++) {
          const length = Math.min(size, entry.size - block * size);
          group.items.push(known ? { key: `${entry.path}:${block * size}`, length } : { length, take() { } });
          group.size += length;
        }
      };

      for (const [file, first, count] of group.lead) add(index.files[file], first, count);

      for (const file of group.files) {
        const entry = index.files[file];
        entry.group = group;
        add(entry, 0, Math.ceil(entry.size / size));
      }
    }

    const program = this.entries.get("minecraftstorymode.exe");
    const first = groups[0];
    const joined = end > start && end - start <= 16777216 && program &&
      program.offset === end && first && first.offset === end + program.size && this.fits(first);

    const items = [];
    let early = null;

    if (end > start && end - start <= 16777216) {
      early = {
        length: end - start,
        take: bytes => {
          for (const entry of preloaded) {
            entry.bytes = bytes.subarray(entry.offset - start, entry.offset - start + entry.size);
          }
        }
      };
      items.push(early);
    } else {
      for (const entry of preloaded) {
        entry.bytes = await this.slice(entry.offset, entry.size);
      }
    }

    if (joined) {
      const binary = { length: program.size, take: bytes => { program.held = bytes; } };
      items.push(binary);
      for (const item of first.items) items.push(item);
      first.started = true;
      this.pull(start, items, false);
      program.arriving = binary.promise;
    } else if (early) {
      this.pull(start, items, false);
    }

    if (early) await early.promise;
    if (first) this.stream(first);
  },

  fits(group) {
    return group.size <= this.blockLimit * this.blockSize * 0.75;
  },

  stream(group) {
    if (group.started || !this.fits(group)) return;
    group.started = true;
    this.pull(group.offset, group.items, false);
  },

  resolve(path) {
    const normalized = this.normalize(path);
    const direct = this.entries.get(normalized) || this.entries.get(this.normalize(`${this.cwd}/${path}`));
    if (direct || normalized.includes("/")) return direct;
    return Array.from(this.entries.entries()).find(([key]) => key.endsWith(`/${normalized}`))?.[1];
  },

  open(path, disposition = 3) {
    let entry = this.resolve(path);
    const key = this.normalize(path);

    if (disposition === 1 && entry) return -80;
    if (disposition === 5 && !entry) return -2;

    const creates = disposition === 1 || disposition === 2 || disposition === 4;

    if (!entry && (creates || /(^|\/)session_[^/]*\.estore$/i.test(key))) {
      entry = { path: key, size: 0, directory: false, dynamic: true, bytes: new Uint8Array() };
      this.entries.set(key, entry);
    }

    if (!entry || entry.directory) return -2;

    if (disposition === 2 || disposition === 5) {
      entry.dynamic = true;
      entry.bytes = new Uint8Array();
      entry.size = 0;
    }

    const handle = this.nextHandle++;
    this.handles.set(handle, { entry, position: 0 });
    return handle;
  },

  persist(entry) {
    if (!entry || !entry.dynamic || !/^documents\//.test(entry.path)) return;

    try {
      let text = "";
      for (let i = 0; i < entry.bytes.length; i++) text += String.fromCharCode(entry.bytes[i]);
      localStorage.setItem("mcsm:" + entry.path, btoa(text));
    } catch (error) { }
  },

  restore() {
    try {
      if (localStorage.getItem("mcsm-save-format") !== "2") {
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i);
          if (name && name.startsWith("mcsm:")) stale.push(name);
        }
        for (const name of stale) localStorage.removeItem(name);
        localStorage.setItem("mcsm-save-format", "2");
      }

      if (localStorage.getItem("mcsm-prefs-format") !== "2") {
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
          const name = localStorage.key(i);
          if (name && /^mcsm:.*\/prefs\.prop$/.test(name)) stale.push(name);
        }
        for (const name of stale) localStorage.removeItem(name);
        localStorage.setItem("mcsm-prefs-format", "2");
      }

      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name || !name.startsWith("mcsm:")) continue;

        const text = atob(localStorage.getItem(name));
        const bytes = new Uint8Array(text.length);
        for (let j = 0; j < text.length; j++) bytes[j] = text.charCodeAt(j);

        const path = name.slice(5);
        this.entries.set(path, { path, size: bytes.length, directory: false, dynamic: true, bytes });
      }
    } catch (error) { }
  },

  close(handle) {
    const file = this.handles.get(handle);
    if (file && file.entry && file.entry.dynamic) this.persist(file.entry);
    return this.handles.delete(handle);
  },

  seek(handle, distance, origin) {
    const file = this.handles.get(handle);
    if (!file || file.matches || ![0, 1, 2].includes(origin)) return -1;

    const next = distance + (origin === 1 ? file.position : origin === 2 ? file.entry.size : 0);
    if (!Number.isSafeInteger(next) || next < 0) return -1;

    file.position = next;
    return next;
  },

  async read(handle, count, offset) {
    const file = this.handles.get(handle);
    if (!file || file.matches) throw new Error("Invalid file handle");

    const start = offset === undefined ? file.position : offset;
    const size = Math.min(count, Math.max(0, file.entry.size - start));
    if (!size) return new Uint8Array();

    const bytes = file.entry.bytes
      ? file.entry.bytes.slice(start, start + size)
      : await this.slice(file.entry.offset + start, size);

    if (offset === undefined) file.position += bytes.length;
    return bytes;
  },

  readCached(handle, count, offset) {
    const file = this.handles.get(handle);
    if (!file || !file.entry || !file.entry.bytes) return null;

    const start = offset === undefined ? file.position : offset;
    const bytes = file.entry.bytes.subarray(start, Math.min(start + count, file.entry.bytes.length));

    if (offset === undefined) file.position += bytes.length;
    return bytes;
  },

  write(handle, bytes, offset) {
    const file = this.handles.get(handle);
    if (!file || !file.entry || !file.entry.dynamic) return -1;

    const start = offset === undefined ? file.position : offset;
    const end = start + bytes.length;

    if (end > file.entry.bytes.length) {
      const expanded = new Uint8Array(end);
      expanded.set(file.entry.bytes);
      file.entry.bytes = expanded;
    }

    file.entry.bytes.set(bytes, start);
    file.entry.size = file.entry.bytes.length;
    if (offset === undefined) file.position = end;
    return bytes.length;
  },

  forget(entry) {
    this.entries.delete(entry.path);
    try { localStorage.removeItem("mcsm:" + entry.path); } catch (error) { }
  },

  remove(path) {
    const entry = this.resolve(path);
    if (!entry || entry.directory) return 2;
    if (!entry.dynamic) return 5;

    for (const file of this.handles.values()) {
      if (file.entry === entry) return 32;
    }

    this.forget(entry);
    return 0;
  },

  rename(from, to, replace) {
    const entry = this.resolve(from);
    if (!entry || entry.directory) return 2;
    if (!entry.dynamic) return 5;

    const key = this.normalize(to);
    if (!key) return 3;

    const existing = this.entries.get(key);
    if (existing && existing !== entry) {
      if (!replace) return 183;
      if (!existing.dynamic) return 5;
      this.forget(existing);
    }

    this.forget(entry);
    entry.path = key;
    this.entries.set(key, entry);
    this.persist(entry);
    return 0;
  },

  truncate(handle) {
    const file = this.handles.get(handle);
    if (!file || !file.entry || !file.entry.dynamic) return false;

    const bytes = new Uint8Array(file.position);
    bytes.set(file.entry.bytes.subarray(0, Math.min(file.position, file.entry.bytes.length)));
    file.entry.bytes = bytes;
    file.entry.size = bytes.length;
    return true;
  },

  flush(handle) {
    const file = this.handles.get(handle);
    if (!file || !file.entry) return false;
    if (file.entry.dynamic) this.persist(file.entry);
    return true;
  },

  pending: new Map(),
  readAhead: 4,
  readAheadLimit: 64,
  asyncReads: 0,

  trouble(active) {
    if (typeof document === "undefined") return;

    let notice = document.getElementById("network");
    if (!notice) {
      if (!active) return;

      notice = document.createElement("div");
      notice.id = "network";
      notice.textContent = "Connection lost. Retrying…";
      notice.style.cssText = "position:absolute;left:50%;top:24px;transform:translateX(-50%);padding:8px 16px;background:rgba(0,0,0,.8);color:#fff;font:16px ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:4px;z-index:10";
      document.body.appendChild(notice);
    }

    notice.style.display = active ? "block" : "none";
  },

  deliver(item, bytes) {
    if (item.take) item.take(bytes);
    else if (!this.blockCache.has(item.key)) {
      this.blockCache.set(item.key, bytes);
      while (this.blockCache.size > this.blockLimit) {
        this.blockCache.delete(this.blockCache.keys().next().value);
      }
    }

    if (item.key && this.pending.get(item.key) === item.promise) this.pending.delete(item.key);
    item.resolve();
  },

  pulls: 0,
  active: new Map(),

  download: function () {
    const pause = time => new Promise(resolve => setTimeout(resolve, time));

    onmessage = async event => {
      const { id, offset, lengths } = event.data;
      let next = 0;
      let failures = 0;
      let batch = [];
      let held = 0;
      let sent = performance.now();

      const flush = () => {
        if (!batch.length) return;
        postMessage({ id, blocks: batch }, batch);
        batch = [];
        held = 0;
        sent = performance.now();
      };

      while (next < lengths.length) {
        let moved = false;

        try {
          const index = Math.floor((offset + lengths.slice(0, next).reduce((a, b) => a + b, 0)) / 20971520);
          const absolute = offset + lengths.slice(0, next).reduce((a, b) => a + b, 0);
          const partOffset = absolute - index * 20971520;
          const response = await fetch(`game-files/game.data.part${String(index).padStart(3, "0")}`);

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const bytes = new Uint8Array(await response.arrayBuffer());
          let cursor = partOffset;

          while (cursor < bytes.length && next < lengths.length) {
            const length = lengths[next];
            const block = new Uint8Array(length);
            const count = Math.min(length, bytes.length - cursor);
            block.set(bytes.subarray(cursor, cursor + count));
            if (count !== length) break;

            batch.push(block.buffer);
            held += length;
            next++;
            cursor += length;
            moved = true;

            if (held >= 2097152 || performance.now() - sent > 40) flush();
          }
        } catch (error) { }

        flush();

        if (next >= lengths.length) break;

        failures = moved ? 0 : failures + 1;
        postMessage({ id, trouble: failures > 1 });
        await pause(Math.min(3000, 250 * 2 ** Math.min(failures, 4)));
      }

      flush();
      postMessage({ id, finished: true });
    };
  },

  helper() {
    if (this.worker !== undefined) return this.worker;
    this.worker = null;
    return null;
  },

  arrived(data) {
    const job = this.active.get(data.id);
    if (!job) return;

    if (data.blocks) {
      for (const block of data.blocks) {
        const item = job.items[job.next++];
        job.done += item.length;
        this.deliver(item, new Uint8Array(block));
      }
    }

    if (data.trouble !== undefined) this.trouble(data.trouble);

    if (data.failed) {
      this.active.delete(data.id);
      this.abandon(job, new Error(`Split game.data read failed: ${data.failed}`));
    }

    if (data.finished) {
      this.active.delete(data.id);
      this.trouble(false);
    }
  },

  abandon(job, error) {
    for (let index = job.next; index < job.items.length; index++) {
      const item = job.items[index];
      if (item.key && this.pending.get(item.key) === item.promise) this.pending.delete(item.key);
      item.reject(error);
    }
  },


  async drain(job) {
    const items = job.items;

    try {
      while (job.next < items.length) {
        const item = items[job.next];
        const absoluteStart = job.offset + job.done;
        let completed = false;
        let lastError = null;

        for (let attempt = 0; attempt < 9 && !completed; attempt++) {
          try {
            const output = new Uint8Array(item.length);
            let copied = 0;

            while (copied < item.length) {
              const position = absoluteStart + copied;
              const partIndex = Math.floor(position / this.partSize);
              const partOffset = position - partIndex * this.partSize;
              const bytes = await this.getPart(partIndex);

              if (partOffset >= bytes.length) {
                throw new Error(
                  `Incomplete game.data part ${partIndex}`
                );
              }

              const count = Math.min(
                item.length - copied,
                bytes.length - partOffset
              );

              if (count <= 0) {
                throw new Error(
                  `Unable to read game.data part ${partIndex}`
                );
              }

              output.set(
                bytes.subarray(partOffset, partOffset + count),
                copied
              );

              copied += count;
            }

            this.deliver(item, output);
            job.next++;
            job.done += item.length;
            completed = true;
          } catch (error) {
            lastError = error;
            this.trouble(true);

            if (attempt < 8) {
              const delay = Math.min(
                3000,
                250 * 2 ** Math.min(attempt, 4)
              );

              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }

        if (!completed) {
          throw lastError ||
          new Error("Unable to read split game.data parts");
        }
      }

      this.trouble(false);
    } catch (error) {
      console.error("[MCSM filesystem] Split data read failed:", error);
      this.abandon(job, error);
    }
  },


  pull(offset, items, claim) {
    const job = { items, offset, next: 0, done: 0, began: performance.now() };

    let total = 0;
    for (const item of items) {
      const at = total;
      total += item.length;

      item.promise = new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
      });
      item.promise.catch(() => { });
      item.promise.far = () => {
        const seconds = (performance.now() - job.began) / 1000;
        return (at - job.done) / (job.done > 4194304 ? job.done / seconds : 8388608) > 20;
      };

      if (item.key && (claim || !this.pending.has(item.key))) {
        this.pending.set(item.key, item.promise);
      }
    }

    this.drain(job);
    return items;
  },

  fetchRange(entry, first, last) {
    const size = this.blockSize;
    const items = [];

    for (let block = first; block <= last; block++) {
      items.push({
        key: `${entry.path}:${block * size}`,
        length: Math.min(size, entry.size - block * size)
      });
    }

    return this.pull(entry.offset + first * size, items, true);
  },

  gather(entry, first, last, waits, extra = 0) {
    const size = this.blockSize;
    const final = Math.floor(Math.max(0, entry.size - 1) / size);
    const need = Math.min(last, final);
    const limit = Math.min(last + extra, final);
    let run = -1;

    const send = end => {
      const items = this.fetchRange(entry, run, end);
      if (waits) {
        for (let block = run; block <= Math.min(end, need); block++) {
          waits.push(items[block - run].promise);
        }
      }
      run = -1;
    };

    for (let block = first; block <= limit; block++) {
      const key = `${entry.path}:${block * size}`;
      const held = this.blockCache.has(key);
      let inFlight = held ? null : this.pending.get(key);

      if (inFlight && waits && inFlight.far()) inFlight = null;

      if (held || inFlight) {
        if (inFlight && waits && block <= need) {
          waits.push(inFlight.catch(() => this.fetchRange(entry, block, block)[0].promise));
        }
        if (run >= 0) send(block - 1);
        if (block >= need) break;
        continue;
      }

      if (block > need && run < 0) break;
      if (run < 0) run = block;
    }

    if (run >= 0) send(limit);
  },

  request(handle, count, offset, flag) {
    if (this.asyncDisabled) return -1;

    const file = this.handles.get(handle);
    if (!file || file.matches || !file.entry || file.entry.bytes || file.entry.dynamic) return -1;

    const entry = file.entry;
    const start = offset === undefined ? file.position : offset;
    const length = Math.min(count, Math.max(0, entry.size - start));
    if (!length) return 1;

    const size = this.blockSize;
    const first = Math.floor(start / size);
    const last = Math.floor((start + length - 1) / size);
    const group = entry.group;

    if (group && !group.started) {
      for (let block = first; block <= last; block++) {
        const key = `${entry.path}:${block * size}`;
        if (!this.blockCache.has(key) && !this.pending.has(key)) group.read += size;
      }
      if (group.read) this.stream(group);
    }

    const waits = [];
    this.gather(entry, first, last, waits, 15);

    const streaming = file.streamEnd === start;
    file.streak = streaming ? file.streak + length : length;
    file.streamEnd = start + length;

    if (this.readAhead && streaming && !group) {
      const reach = Math.min(this.readAheadLimit, Math.max(this.readAhead, Math.ceil(file.streak / size)));
      const final = Math.floor(Math.max(0, entry.size - 1) / size);
      let covered = 0;

      while (covered < reach && last + 1 + covered <= final) {
        const key = `${entry.path}:${(last + 1 + covered) * size}`;
        if (!this.blockCache.has(key) && !this.pending.has(key)) break;
        covered++;
      }

      if (covered * 2 <= reach && last + 1 + covered <= final) {
        this.gather(entry, last + 1 + covered, last + reach, null);
      }
    }

    if (!waits.length) return 1;

    this.asyncReads++;
    Module.HEAPU32[flag >>> 2] = 0;

    const finish = value => {
      Module.HEAPU32[flag >>> 2] = value;
      if (Module._mcsm_mt_start) {
        Atomics.notify(Module.HEAP32 || new Int32Array(Module.HEAPU8.buffer), flag >>> 2);
      }
      const wake = Module.mcsmIoWake;
      if (wake) wake();
    };

    Promise.all(waits).then(() => finish(1), () => finish(2));
    return 0;
  },

  readSync(handle, count, offset) {
    const file = this.handles.get(handle);
    if (!file || file.matches || !file.entry) return null;

    const start = offset === undefined ? file.position : offset;
    const size = Math.min(count, Math.max(0, file.entry.size - start));
    if (!size) return new Uint8Array();

    if (file.entry.bytes) {
      const output = file.entry.bytes.slice(start, start + size);
      if (offset === undefined) file.position += output.length;
      return output;
    }

    if (this.coverage) {
      this.coverage.bytes += size;
      this.coverage.reads++;
      for (let page = Math.floor(start / 4096); page <= Math.floor((start + size - 1) / 4096); page++) {
        this.coverage.pages.add(`${file.entry.path}:${page}`);
      }
    }

    const output = new Uint8Array(size);
    let source = start;
    let destination = 0;

    while (destination < size) {
      const blockStart = Math.floor(source / this.blockSize) * this.blockSize;
      const key = `${file.entry.path}:${blockStart}`;
      let block = this.blockCache.get(key);

      if (this.record && !this.record.has(key)) this.record.set(key, this.record.size);

      if (block) {
        this.blockHits++;
        this.blockCache.delete(key);
        this.blockCache.set(key, block);
      } else {
        this.blockMisses++;
        const blockEnd = Math.min(blockStart + this.blockSize, file.entry.size) - 1;
        const absolute = file.entry.offset + blockStart;
        const absoluteEnd = file.entry.offset + blockEnd;
        const partIndex = Math.floor(absolute / this.partSize);
        const partOffset = absolute - partIndex * this.partSize;

        // Synchronous XHR is retained for the original readSync interface.
        // Read the full containing part, then extract the requested block.
        const request = new XMLHttpRequest();
        request.open("GET", `game-files/game.data.part${String(partIndex).padStart(3, "0")}`, false);
        request.send();

        if (request.status !== 200) throw new Error(`Split data read failed: ${request.status}`);

        const part = new Uint8Array(request.response.length);
        for (let i = 0; i < request.response.length; i++) {
          part[i] = request.response.charCodeAt(i) & 255;
        }

        const length = blockEnd - blockStart + 1;
        block = part.slice(partOffset, partOffset + length);

        if (block.length !== length) throw new Error("Short split data response");

        this.blockCache.set(key, block);
        while (this.blockCache.size > this.blockLimit) {
          this.blockCache.delete(this.blockCache.keys().next().value);
        }
      }

      const within = source - blockStart;
      const available = Math.min(block.length - within, size - destination);

      if (available <= 0) throw new Error("Short cached range response");

      output.set(block.subarray(within, within + available), destination);
      source += available;
      destination += available;
    }

    if (offset === undefined) file.position += output.length;
    return output;
  },

  find(pattern) {
    let normalized = this.normalize(pattern);
    if (normalized.endsWith("*.*")) normalized = normalized.slice(0, -3) + "*";

    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    const matcher = new RegExp(`^${escaped}$`, "i");
    const matches = Array.from(this.entries.entries())
      .filter(([key, entry]) => entry.path && matcher.test(key))
      .map(([, entry]) => entry);

    if (!matches.length) return -1;

    const handle = this.nextHandle++;
    this.handles.set(handle, { matches, index: 0 });
    return handle;
  }
};
