
const startButton = document.getElementById("start");
const startStatus = document.getElementById("status");

function fail(error) {
  const text = error && (error.stack || error.message) || String(error);
  console.error(text);
  startStatus.textContent = error && error.message || text;
}

/* Split game.data loader: fetch only requested byte ranges. */
(() => {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const PART_COUNT = 324;
  const CHUNK_SIZE = 20 * 1024 * 1024;
  const partCache = new Map();
  let totalSizePromise = null;

  function progress(value, label) {
    const percent = Math.max(0, Math.min(100, Number(value) || 0));

    if (typeof globalThis.setGameLoadingProgress === "function") {
      globalThis.setGameLoadingProgress(percent, label);
    }

    if (label) startStatus.textContent = label;
  }

  async function getPart(index) {
    if (index < 0 || index >= PART_COUNT) {
      throw new Error(`Invalid game.data part index: ${index}`);
    }

    if (!partCache.has(index)) {
      const name = `game.data.part${String(index).padStart(3, "0")}`;
      const url = new URL(`game-files/${name}`, location.href);

      const promise = originalFetch(url.href).then(async response => {
        if (!response.ok) {
          throw new Error(`${name}: HTTP ${response.status}`);
        }

        const bytes = await response.arrayBuffer();

        if (bytes.byteLength > CHUNK_SIZE) {
          throw new Error(`${name} exceeds 20 MiB`);
        }

        if (index < PART_COUNT - 1 && bytes.byteLength !== CHUNK_SIZE) {
          throw new Error(
            `${name} is ${bytes.byteLength} bytes; expected ${CHUNK_SIZE}.`
          );
        }

        return bytes;
      });

      partCache.set(index, promise);

      promise.catch(() => {
        if (partCache.get(index) === promise) {
          partCache.delete(index);
        }
      });
    }

    return partCache.get(index);
  }

  async function getTotalSize() {
    if (!totalSizePromise) {
      totalSizePromise = (async () => {
        const last = await getPart(PART_COUNT - 1);

        if (!last.byteLength) {
          throw new Error("The final game.data part is empty.");
        }

        return (PART_COUNT - 1) * CHUNK_SIZE + last.byteLength;
      })().catch(error => {
        totalSizePromise = null;
        throw error;
      });
    }

    return totalSizePromise;
  }

  globalThis.loadSplitGameData = async function () {
    throw new Error(
      "Full game.data merging is disabled. The filesystem reader must use byte ranges."
    );
  };

  globalThis.fetch = async function (input, init) {
    const requestUrl =
      input instanceof Request ? input.url : String(input);

    const url = new URL(requestUrl, location.href);
    const pathname = url.pathname.replace(/\/+$/, "");

    if (pathname !== "/game.data" && !pathname.endsWith("/game.data")) {
      return originalFetch(input, init);
    }

    const method = (
      init?.method ||
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      return originalFetch(input, init);
    }

    const headers = new Headers(
      input instanceof Request ? input.headers : undefined
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    const range = headers.get("Range");

    if (!range) {
      return new Response(
        "game.data is split into parts. A byte-range request is required.",
        {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Type": "text/plain"
          }
        }
      );
    }

    const totalSize = await getTotalSize();
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    if (!match || (!match[1] && !match[2])) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` }
      });
    }

    let start;
    let end;

    if (!match[1]) {
      const suffixLength = Number(match[2]);

      if (!suffixLength) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${totalSize}` }
        });
      }

      start = Math.max(0, totalSize - suffixLength);
      end = totalSize - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : totalSize - 1;
    }

    if (start >= totalSize || end < start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` }
      });
    }

    end = Math.min(end, totalSize - 1);

    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Length": String(end - start + 1),
      "Content-Type": "application/octet-stream"
    };

    if (method === "HEAD") {
      return new Response(null, { status: 206, headers: commonHeaders });
    }

    const firstPart = Math.floor(start / CHUNK_SIZE);
    const lastPart = Math.floor(end / CHUNK_SIZE);
    const output = new Uint8Array(end - start + 1);
    let outputOffset = 0;

    for (let index = firstPart; index <= lastPart; index++) {
      const part = new Uint8Array(await getPart(index));
      const partStart = index * CHUNK_SIZE;
      const from = Math.max(start, partStart) - partStart;
      const to = Math.min(end + 1, partStart + part.byteLength) - partStart;

      if (to <= from) {
        throw new Error(`Invalid byte range for game.data part ${index}`);
      }

      const slice = part.subarray(from, to);
      output.set(slice, outputOffset);
      outputOffset += slice.byteLength;
    }

    return new Response(output, {
      status: 206,
      headers: commonHeaders
    });
  };
})();

function readU16(view, offset) {
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  return view.getUint32(offset, true);
}

function mapPe(bytes, heap) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = readU32(view, 0x3c);
  const sectionCount = readU16(view, peOffset + 6);
  const optionalSize = readU16(view, peOffset + 20);
  const optionalOffset = peOffset + 24;
  const imageBase = readU32(view, optionalOffset + 28);
  const headerSize = readU32(view, optionalOffset + 60);

  heap.set(bytes.subarray(0, headerSize), imageBase);

  const sectionTable = optionalOffset + optionalSize;

  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40;
    const virtualAddress = readU32(view, entry + 12);
    const rawSize = readU32(view, entry + 16);
    const rawOffset = readU32(view, entry + 20);

    if (rawSize) {
      heap.set(
        bytes.subarray(rawOffset, rawOffset + rawSize),
        imageBase + virtualAddress
      );
    }
  }
}

globalThis.MCSMShaderPairs = (() => {
  const key = "mcsm-shader-pairs-1";
  const known = new Set();

  const absorb = text => {
    for (let at = 0; at + 32 <= text.length; at += 32) {
      const pair = text.slice(at, at + 32);
      if (/^[0-9a-f]{32}$/.test(pair)) known.add(pair);
    }
  };

  try {
    absorb(localStorage.getItem(key) || "");
  } catch (error) {}

  let timer = 0;

  const save = () => {
    timer = 0;

    try {
      localStorage.setItem(
        key,
        Array.from(known).slice(-60000).join("")
      );
    } catch (error) {}
  };

  return {
    known,

    add(pair) {
      if (known.has(pair)) return;
      known.add(pair);

      if (!timer) timer = setTimeout(save, 5000);
    }
  };
})();

const DEFAULT_WINDOW_SIZE = 0xD895A4;

const importsRequest = fetch("imports.json");
const audioReady = MCSMFmod.load();
const filesReady = MCSMFiles.init();
const exeRequest = filesReady.then(() =>
  MCSMFiles.whole("MinecraftStoryMode.exe")
);

for (const request of [
  importsRequest,
  audioReady,
  filesReady,
  exeRequest
]) request.catch(() => {});

async function prepare() {
  progressPlaceholder();
  await filesReady;
  await audioReady;

  const [bytes, importsResponse] = await Promise.all([
    exeRequest,
    importsRequest
  ]);

  if (!importsResponse.ok) {
    throw new Error(`Import manifest failed: ${importsResponse.status}`);
  }

  const imports = await importsResponse.json();
  MCSMFmod.bind(imports);
  mapPe(bytes, Module.HEAPU8);

  const memoryView = new DataView(Module.HEAPU8.buffer);

  for (const item of imports) {
    memoryView.setUint32(item.iat, item.token, true);
  }

  const config = globalThis.MCSMConfig || {
    render: [1920, 1080],
    output: [1920, 1080],
    antialias: 1,
    anisotropy: 16
  };

  Module.mcsmRenderWidth = config.render[0];
  Module.mcsmRenderHeight = config.render[1];

  memoryView.setFloat32(DEFAULT_WINDOW_SIZE, config.render[0], true);
  memoryView.setFloat32(DEFAULT_WINDOW_SIZE + 4, config.render[1], true);

  if (Module._mcsm_set_render_size) {
    Module._mcsm_set_render_size(config.render[0], config.render[1]);
  }

  if (Module._mcsm_set_output) {
    Module._mcsm_set_output(
      config.output[0],
      config.output[1],
      config.antialias
    );
  }

  if (Module._mcsm_set_anisotropy) {
    Module._mcsm_set_anisotropy(config.anisotropy);
  }

  const query = new URLSearchParams(location.search);

  if (Module._mcsm_set_half_pixel && query.get("halfpixel") === "0") {
    Module._mcsm_set_half_pixel(0);
  }

  if (Module._mcsm_set_fix_flags) {
    Module._mcsm_set_fix_flags(
      query.has("fix")
        ? Number(query.get("fix")) >>> 0
        : 2154689 | (config.shadows ? 526 : 4390912)
    );
  }

  if (Module._mcsm_set_slice && query.has("slice")) {
    Module._mcsm_set_slice(Number(query.get("slice")));
  }

  if (Module._mcsm_set_clip_mode && query.has("clip")) {
    Module._mcsm_set_clip_mode(Number(query.get("clip")));
  }

  Module._mcsm_runtime_init();

  for (const entry of MCSMFiles.entries.values()) {
    if (!entry.bytes || entry.dynamic) continue;

    const name = entry.path.split("/").pop();
    const namePointer = Module._malloc(name.length + 1);
    const dataPointer = Module._malloc(entry.bytes.length);

    Module.HEAPU8.set(new TextEncoder().encode(name + "\0"), namePointer);
    Module.HEAPU8.set(entry.bytes, dataPointer);

    Module._mcsm_register_preloaded_file(
      namePointer,
      dataPointer,
      entry.bytes.length
    );

    Module._free(namePointer);
  }

  startButton.disabled = false;
  startStatus.textContent = "Click to start";

  if (typeof globalThis.setGameLoadingProgress === "function") {
    globalThis.setGameLoadingProgress(100, "Ready to start");
  }
}

/* Allows prepare() to start without depending on the optional loading-bar UI. */
function progressPlaceholder() {
  if (typeof globalThis.setGameLoadingProgress === "function") {
    globalThis.setGameLoadingProgress(10, "Preparing game...");
  }
}

var Module = {
  canvas: document.getElementById("canvas"),

  mcsmUncapped:
    new URLSearchParams(location.search).has("uncapped") ||
    !!(
      globalThis.MCSMConfig &&
      MCSMConfig.settings &&
      MCSMConfig.settings.fps === "uncapped"
    ),

  mcsmGpuPace: new URLSearchParams(location.search).has("gpupace")
    ? Number(new URLSearchParams(location.search).get("gpupace"))
    : 1,

  onRuntimeInitialized() {
    Module.mcsmReady = true;
    prepare().catch(fail);
  }
};

const WINDOWED_FLAG = 0xDD3D8D;

function luaRun(code, match = /^(?!@)/, repeat = false) {
  (globalThis.mcsmLuaInject = globalThis.mcsmLuaInject || []).push({
    match,
    code,
    prepend: true,
    quiet: true,
    repeat
  });
}

luaRun(`if Menu_Add and Menu_Add ~= mcsmMenuAdd then
  local add = Menu_Add
  local removed = {["Main_AccountLink()"] = true, ["Menu_AccountSettings()"] = true, ["Menu_Main_Stats()"] = true, ["Menu_Main_Exit()"] = true}
  local nothing = function() end
  local absent = setmetatable({}, {__index = function() return nothing end, __newindex = nothing})
  mcsmMenuAdd = function(...)
    local command = select(4, ...)
    if command and removed[command] then return absent end
    return add(...)
  end
  Menu_Add = mcsmMenuAdd
end`, /^Menu_Main_Start\(\)/, true);

luaRun(`if UI_Notify and ThreadStart then ThreadStart(function()
  Sleep(1)
  ThreadStart(function()
    for attempt = 1, 600 do
      local found = {}
      local listed, agents = pcall(SceneGetAgents, "ui_popup.scene")
      if listed and agents then
        for _, agent in ipairs(agents) do found[AgentGetName(agent)] = agent end
      end
      local window, button, face, header, message = found.ui_popup_window, found.ui_popup_button1, found.ui_popup_button1_button, found.ui_popup_header, found.ui_popup_message
      if window and button and face and header and message and AgentGetPos(button).y < -0.5 then
        local saved = {}
        local set = function(agent, key, value)
          saved[#saved + 1] = {agent, key, AgentGetProperty(agent, key)}
          AgentSetProperty(agent, key, value)
        end
        local move = function(agent, x, y)
          local place = AgentGetPos(agent)
          saved[#saved + 1] = {agent, false, Vector(place.x, place.y, place.z)}
          AgentSetPos(agent, Vector(x, y, place.z))
        end
        set(window, "Render Global Scale", 0.66)
        set(window, "Render Axis Scale", Vector(1, 1.105, 1))
        move(button, -0.03, -1.172)
        set(face, "Render Axis Scale", Vector(0.66, 0.78, 1))
        set(header, "Text Scale", 1.15)
        set(header, "Text Alignment Horizontal", 2)
        set(header, "Text Color", Color(0.2, 0.2, 0.2, 1))
        move(header, -0.03, 1.149)
        set(message, "Text Scale", 1.15)
        set(message, "Text Alignment Horizontal", 2)
        set(message, "Text Color", Color(0.29, 0.29, 0.29, 1))
        move(message, -0.03, 0.759)
        local show = Popup
        Popup = function(...)
          Popup = show
          pcall(function()
            for index = #saved, 1, -1 do
              local item = saved[index]
              if item[2] then AgentSetProperty(item[1], item[2], item[3]) else AgentSetPos(item[1], item[3]) end
            end
          end)
          return show(...)
        end
        return
      end
      WaitForNextFrame()
    end
  end)
  UI_Notify("Before you play", "This is an early version of\\nMinecraft: Story Mode in web.\\nThere WILL be bugs and\\nperformance issues.")
end) end`, /^Menu_Main_Start\(\)/);

const windowedHook = "if Settings_Set and not mcsmWindowedHook then mcsmWindowedHook = true local original = Settings_Set Settings_Set = function(key, value, ...) local result = original(key, value, ...) if key == 'Windowed' and IsFullScreen() == (value and true or false) then FullScreen(not value) end return result end end";

luaRun(windowedHook, /^Menu_Main_Start\(\)/);
luaRun(windowedHook, /^Menu_Options\(\)/);
luaRun(windowedHook, /^Menu_Graphics\(\)/);

function syncFullscreen() {
  let previous = null;

  const browserFullscreen = () =>
    !!(document.fullscreenElement || document.webkitFullscreenElement);

  const enter = () => {
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;

    if (!request) {
      return Promise.reject(new Error("fullscreen unsupported"));
    }

    return Promise.resolve(request.call(root, { navigationUI: "hide" }));
  };

  const leave = () => {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;

    if (exit && browserFullscreen()) {
      Promise.resolve(exit.call(document)).catch(() => {});
    }
  };

  let aspect = 0;

  const tick = () => {
    const canvas = Module.canvas;

    if (
      canvas.width &&
      canvas.height &&
      canvas.width / canvas.height !== aspect
    ) {
      aspect = canvas.width / canvas.height;
      canvas.style.setProperty("--aspect", String(aspect));
    }

    const heap = Module.HEAPU8;

    if (heap) {
      const windowed = heap[WINDOWED_FLAG];

      if (previous === null) {
        if (!windowed && !browserFullscreen()) heap[WINDOWED_FLAG] = 1;
        previous = heap[WINDOWED_FLAG];
      } else if (windowed !== previous) {
        previous = windowed;

        if (!windowed && !browserFullscreen()) {
          enter().catch(() => {
            Module.HEAPU8[WINDOWED_FLAG] = 1;
            previous = 1;
          });
        } else if (windowed) {
          leave();
        }
      }
    }

    requestAnimationFrame(tick);
  };

  const changed = () => {
    const heap = Module.HEAPU8;
    if (!heap) return;

    if (!browserFullscreen() && !heap[WINDOWED_FLAG]) {
      luaRun("if IsFullScreen() then FullScreen(false) end");

      setTimeout(() => {
        if (!browserFullscreen() && !Module.HEAPU8[WINDOWED_FLAG]) {
          Module.HEAPU8[WINDOWED_FLAG] = 1;
          previous = 1;
        }
      }, 3000);
    }

    Module.canvas.focus();
  };

  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("webkitfullscreenchange", changed);
  requestAnimationFrame(tick);
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  startButton.classList.add("hidden");

  const optionsPanel = document.getElementById("options");
  if (optionsPanel) optionsPanel.classList.add("hidden");

  Module.canvas.focus();
  syncFullscreen();

  try {
    if (Module._mcsm_mt_start) {
      const hosting = new URLSearchParams(location.search).get("mt") || "";

      Module._mcsm_mt_options(
        hosting === "main" || hosting === "first" ? 1 : 0,
        hosting === "main" || hosting === "jobs" ? 1 : 0
      );

      await Module.ccall("mcsm_mt_start", null, [], [], { async: true });
    } else {
      await Module.ccall("xbe_entry_point", null, [], [], { async: true });
    }
  } catch (error) {
    if (Module._mcsm_dump_ring) Module._mcsm_dump_ring();
    fail(error);
  }
});

const jspiSupported =
  typeof WebAssembly.Suspending === "function" &&
  typeof WebAssembly.promising === "function";

const buildQuery = new URLSearchParams(location.search);
const singleBuild = jspiSupported ? "mcsm_r4" : "mcsm";

const threadCapable =
  jspiSupported &&
  globalThis.crossOriginIsolated === true &&
  typeof SharedArrayBuffer === "function" &&
  (navigator.hardwareConcurrency || 1) >= 2;

const pickerSettings = (globalThis.MCSMConfig && MCSMConfig.settings) || {
  quality: "auto",
  fps: "60",
  aa: "smooth",
  shadows: "auto",
  threads: "on"
};

const threadsAvailable = threadCapable;

let buildName =
  buildQuery.get("build") ||
  (pickerSettings.threads !== "off" && threadCapable
    ? "mcsm_mt"
    : singleBuild);

if (buildName.startsWith("mcsm_mt") && !threadCapable) {
  buildName = singleBuild;
}

if (buildName.startsWith("mcsm_mt")) {
  const reported =
    Number(buildQuery.get("cores")) ||
    Math.min(4, (navigator.hardwareConcurrency || 2) - 2);

  Module.mcsmWorkers = 1 + 5 * Math.max(1, Math.min(8, reported));
}

function leaveThreadedBuild(reason) {
  if (!buildName.startsWith("mcsm_mt") || Module.mcsmReady) return;

  const url = new URL(location.href);

  console.error(
    `[loader] threaded build failed to start (${reason}); reloading with ${singleBuild}`
  );

  url.searchParams.delete("build");

  history.replaceState(
    Object.assign({}, history.state, {
      mcsm: Object.assign({}, pickerSettings, { threads: "off" })
    }),
    "",
    url.href
  );

  location.reload();
}

Module.onAbort = reason => leaveThreadedBuild(String(reason));

addEventListener("error", event => {
  if (String(event.filename || "").includes(`/${buildName}.`)) {
    leaveThreadedBuild(event.message);
  }
});

function setupPicker() {
  const panel = document.getElementById("options");
  if (!panel) return;

  const config = globalThis.MCSMConfig || {};

  const labels = {
    auto: config.detected ? `Auto (${config.detected.tier})` : "Auto",
    "4k": "4K (3840x2160)",
    ultra: "Ultra (1440p to 1080p)",
    high: "High (1080p)",
    medium: "Medium (900p)",
    low: "Low (720p)",
    minimum: "Minimum (540p)"
  };

  const quality = document.getElementById("option-quality");

  for (const [value, text] of Object.entries(labels)) {
    quality.add(new Option(text, value));
  }

  const controlled = {
    quality: ["quality", "res", "out"],
    fps: ["uncapped"],
    aa: ["aa"],
    shadows: ["shadows"],
    threads: ["threads", "build"]
  };

  for (const name of Object.keys(controlled)) {
    const select = document.getElementById(`option-${name}`);
    select.value = pickerSettings[name];

    select.addEventListener("change", () => {
      pickerSettings[name] = select.value;

      let saved = true;

      try {
        localStorage.setItem("mcsm-settings", JSON.stringify(pickerSettings));
      } catch (error) {
        saved = false;
      }

      const url = new URL(location.href);

      for (const parameter of controlled[name]) {
        url.searchParams.delete(parameter);
      }

      history.replaceState(
        Object.assign({}, history.state, {
          mcsm: saved ? null : pickerSettings
        }),
        "",
        url.href
      );

      startButton.disabled = true;
      startStatus.textContent = "Applying...";
      location.reload();
    });
  }

  if (!threadsAvailable) {
    const threads = document.getElementById("option-threads");
    threads.value = "off";
    threads.disabled = true;
    threads.title =
      "Needs a cross-origin isolated page, JSPI and at least two cores";
  }
}

setupPicker();

const engineScript = document.createElement("script");

engineScript.onerror = () =>
  leaveThreadedBuild("script failed to load");

engineScript.src = `${buildName}.js`;
document.body.appendChild(engineScript);
