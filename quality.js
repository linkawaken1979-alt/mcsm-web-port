globalThis.MCSMConfig = (() => {
  const params = new URLSearchParams(location.search)
  const tiers = {
    "4k": {render: [3840, 2160], output: [3840, 2160], antialias: 1, anisotropy: 16, shadows: true},
    ultra: {render: [2560, 1440], output: [1920, 1080], antialias: 1, anisotropy: 16, shadows: true},
    high: {render: [1920, 1080], output: [1920, 1080], antialias: 1, anisotropy: 16, shadows: true},
    medium: {render: [1600, 900], output: [1600, 900], antialias: 1, anisotropy: 4, shadows: true},
    low: {render: [1280, 720], output: [1280, 720], antialias: 1, anisotropy: 2, engine: 4, shadows: false},
    minimum: {render: [960, 540], output: [960, 540], antialias: 1, anisotropy: 1, engine: 1, shadows: false}
  }

  function gpuName() {
    try {
      const gl = document.createElement("canvas").getContext("webgl2")
      if (!gl) return ""
      const extension = gl.getExtension("WEBGL_debug_renderer_info")
      const name = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      const lose = gl.getExtension("WEBGL_lose_context")
      if (lose) lose.loseContext()
      return String(name || "")
    } catch (error) {
      return ""
    }
  }

  function cpuScore() {
    const data = new Float64Array(4096)
    let best = Infinity
    for (let round = 0; round < 5; round++) {
      const start = performance.now()
      let total = 0
      for (let pass = 0; pass < 40; pass++) {
        for (let i = 0; i < data.length; i++) { data[i] = Math.sqrt(i * 1.0001 + pass) + total * 1e-9; total += data[i] }
      }
      best = Math.min(best, performance.now() - start)
      if (total < 0) return 0
    }
    return best
  }

  function detect() {
    const gpu = gpuName()
    const cores = navigator.hardwareConcurrency || 2
    const memory = navigator.deviceMemory || 4
    let cpu = cpuScore()
    try {
      const best = Number(localStorage.getItem("mcsm-cpu-score"))
      if (best > 0 && best < cpu) cpu = best
      else localStorage.setItem("mcsm-cpu-score", String(cpu))
    } catch (error) {}
    const weakGpu = /Mali|Adreno|PowerVR|SwiftShader|llvmpipe|HD Graphics [2-6]\d{2}\b|UHD Graphics 6[0-2]\d|Intel\(R\) HD Graphics\b(?! \d)|Celeron|Pentium|Atom|Apple A\d/i.test(gpu)
    const strongGpu = /Apple M\d|RTX|GTX 1[06-9]|GTX [2-9]|Radeon RX|Arc\(TM\)|Iris\(R\) Xe|Radeon Pro|Quadro/i.test(gpu)
    let tier = "medium"
    if (strongGpu && cores >= 6) tier = "high"
    else if (strongGpu) tier = "medium"
    else if (weakGpu || cpu > 4.5 || cores <= 2 || memory <= 2) tier = cpu > 8 || cores <= 2 ? "minimum" : "low"
    else if (cpu > 2.8 || cores <= 4) tier = "medium"
    else if (cpu < 1.6) tier = "high"
    return {tier, gpu, cores, memory, cpu}
  }

  let stored = {}
  try { stored = JSON.parse(localStorage.getItem("mcsm-settings") || "{}") || {} } catch (error) {}
  if (history.state && history.state.mcsm) stored = Object.assign({}, stored, history.state.mcsm)
  const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback
  const settings = {
    quality: pick(params.get("quality") || stored.quality, ["auto", ...Object.keys(tiers)], "auto"),
    fps: params.has("uncapped") ? "uncapped" : pick(stored.fps, ["60", "uncapped"], "60"),
    aa: params.get("aa") ? (params.get("aa") === "off" ? "sharp" : "smooth") : pick(stored.aa, ["smooth", "sharp"], "smooth"),
    shadows: params.get("shadows") ? (params.get("shadows") === "0" || params.get("shadows") === "off" ? "off" : "on") : pick(stored.shadows, ["auto", "on", "off"], "auto"),
    threads: params.get("threads") ? (params.get("threads") === "0" || params.get("threads") === "off" ? "off" : "on") : pick(stored.threads, ["on", "off"], "on")
  }
  const detected = detect()
  const tier = settings.quality === "auto" ? detected.tier : settings.quality
  const config = Object.assign({tier, detected, settings}, tiers[tier])
  if (settings.aa === "sharp") config.antialias = 0
  if (settings.shadows !== "auto") config.shadows = settings.shadows === "on"
  const size = (value, fallback) => {
    const match = /^(\d{3,4})x(\d{3,4})$/.exec(value || "")
    return match ? [Number(match[1]), Number(match[2])] : fallback
  }
  config.render = size(params.get("res"), config.render)
  config.output = size(params.get("out"), params.get("res") && !params.get("out") ? config.render : config.output)
  if (params.get("aa")) config.antialias = params.get("aa") === "off" ? 0 : 1
  if (params.get("aniso")) config.anisotropy = Math.max(1, Number(params.get("aniso")) || 1)
  if (params.get("shadows")) config.shadows = params.get("shadows") !== "0" && params.get("shadows") !== "off"
  if (params.get("rq")) config.engine = Math.max(1, Math.min(9, Number(params.get("rq")) || 7))
  ;(globalThis.mcsmLuaInject = globalThis.mcsmLuaInject || []).push({
    match: /^Menu_Main_Start\(\)/,
    prepend: true,
    quiet: true,
    repeat: true,
    code: `do local level = ${config.engine || 7} local p = GetPreferences() if p then p["Render Quality"] = level end RenderSetCurQualityLevel(level) RenderAfterEffectsOnOff(level >= 7) RenderSetFXShadowsRenderingQuality(level >= 7 and 2 or 0) end`
  })
  return config
})()
