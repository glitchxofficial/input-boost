(() => {
  const { metro, patcher, ui, plugin, logger } = vendetta;
  const { findByProps } = metro;
  const FluxDispatcher = metro.common?.FluxDispatcher;
  const React = metro.common?.React;

  const store = plugin?.storage ?? {};
  // migration & defaults — slider 0-90 is primary volume, plus full Fiona params
  if (store.gain == null) store.gain = 90;
  if (store.masterGain == null) store.masterGain = 0;
  if (store.inputBoost == null) store.inputBoost = 0;
  if (store.width == null) store.width = 0;
  if (store.pitch == null) store.pitch = 50;
  if (store.reverb == null) store.reverb = 0;
  if (store.eqBass == null) store.eqBass = 50;
  if (store.eqMid == null) store.eqMid = 50;
  if (store.eqTreble == null) store.eqTreble = 50;
  if (store.gateThreshold == null) store.gateThreshold = -40;
  if (store.voiceChanger == null) store.voiceChanger = 'none';
  if (store.formant == null) store.formant = 100;
  if (store.distortion == null) store.distortion = 0;
  if (store.noiseReduction == null) store.noiseReduction = 0;
  if (store.vadEnabled == null) store.vadEnabled = false;
  if (store.vadThreshold == null) store.vadThreshold = -45;
  if (store.duckingEnabled == null) store.duckingEnabled = false;
  if (store.duckingReduction == null) store.duckingReduction = 10;
  if (store.voiceProfile == null) store.voiceProfile = 'auto';
  if (store.bitrate == null) store.bitrate = 512000;
  if (store.raw == null) store.raw = true;
  if (store.stereo == null) store.stereo = true;
  if (store.enabled == null) store.enabled = true;
  if (store.clear == null) store.clear = false;

  const VOICE_PRESETS = { 'none': { pitch: 50, formant: 100, distortion: 0, reverb: 0 }, 'robot': { pitch: 30, formant: 80, distortion: 30, reverb: 10 }, 'chipmunk': { pitch: 75, formant: 150, distortion: 0, reverb: 5 }, 'alien': { pitch: 40, formant: 120, distortion: 20, reverb: 40 }, 'demon': { pitch: 25, formant: 70, distortion: 50, reverb: 30 }, 'giant': { pitch: 30, formant: 60, distortion: 10, reverb: 50 }, 'echo': { pitch: 50, formant: 100, distortion: 0, reverb: 70 }, 'helium': { pitch: 70, formant: 130, distortion: 0, reverb: 10 } };
  const VOICE_PROFILES = { 'auto': {}, 'Male Deep': { eqBass: 65, eqMid: 45, eqTreble: 35, gateThreshold: -45 }, 'Male Medium': { eqBass: 55, eqMid: 50, eqTreble: 45, gateThreshold: -45 }, 'Female Low': { eqBass: 50, eqMid: 55, eqTreble: 55, gateThreshold: -40 }, 'Headset Mic': { eqBass: 45, eqMid: 65, eqTreble: 55, gateThreshold: -50 }, 'Studio Mic': { eqBass: 55, eqMid: 50, eqTreble: 50, gateThreshold: -60 } };
  const PRESETS = { 'Default': {}, 'Bass Boost': { masterGain: 5, eqBass: 80, eqMid: 50, eqTreble: 40 }, 'Voice Clarity': { gateThreshold: -50, eqBass: 40, eqMid: 65, eqTreble: 70 }, 'Wide Stereo': { width: 70, reverb: 15 }, 'Radio Effect': { eqBass: 30, eqMid: 70, eqTreble: 30, width: 20, reverb: 30 }, 'Podcast': { gateThreshold: -55, eqBass: 45, eqMid: 60, eqTreble: 65 }, 'Streamer': { masterGain: 3, gateThreshold: -50, eqMid: 65, width: 40 }, 'ASMR': { gateThreshold: -70, eqBass: 40, eqMid: 50, eqTreble: 70, reverb: 10 } };

  const toSlider = (v) => { let n = Number(v); if (!Number.isFinite(n)) return 90; if (n > 0 && n <= 10) n = n * 10; return Math.max(0, Math.min(90, Math.round(n))); };
  const cfg = () => {
    const slider = toSlider(store.gain);
    const gain = slider / 10;
    const clear = store.clear === true;
    return { enabled: store.enabled !== false, clear, slider, gain, bitrate: store.bitrate === 384000 ? 384000 : 512000, raw: clear ? false : store.raw !== false, stereo: store.stereo !== false };
  };

  const WORKLET_CODE = `
        class FionaEngine extends AudioWorkletProcessor {
            static get parameterDescriptors() {
                return [
                    { name: 'gain', defaultValue: 1.0 },
                    { name: 'boost', defaultValue: 1.0 },
                    { name: 'width', defaultValue: 0.0, maxValue: 1 },
                    { name: 'pitch', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
                    { name: 'reverb', defaultValue: 0.0, maxValue: 1 },
                    { name: 'eqBass', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
                    { name: 'eqMid', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
                    { name: 'eqTreble', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
                    { name: 'gateThreshold', defaultValue: 0.01, maxValue: 0.1 },
                    { name: 'formant', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 },
                    { name: 'distortion', defaultValue: 0.0, maxValue: 1 },
                    { name: 'noiseReduction', defaultValue: 0.0, maxValue: 1 },
                    { name: 'ducking', defaultValue: 0.0, maxValue: 1 }
                ];
            }
            constructor() {
                super();
                this.bufSize = 4096;
                this.bufL = new Float32Array(this.bufSize);
                this.bufR = new Float32Array(this.bufSize);
                this.writePos = 0;
                this.readPos = 0.0;
                this.reverbBuffer = new Float32Array(24000);
                this.reverbPos = 0;
                this.gateEnvelope = 0;
            }
            process(inputs, outputs, parameters) {
                const input = inputs[0]; const output = outputs[0];
                if (!input || input.length === 0) return true;
                const gain = parameters.gain[0]; const boost = parameters.boost[0]; const width = parameters.width[0]; const pitch = parameters.pitch[0];
                const reverbAmt = parameters.reverb[0]; const eqMid = parameters.eqMid[0]; const eqTreble = parameters.eqTreble[0];
                const gateThresh = parameters.gateThreshold[0]; const distortion = parameters.distortion[0]; const noiseReduction = parameters.noiseReduction[0]; const ducking = parameters.ducking[0];
                const inL = input[0]; const inR = input[1] || input[0]; const outL = output[0]; const outR = output[1] || output[0]; const len = inL.length;
                for (let i = 0; i < len; i++) {
                    let L = inL[i] * boost; let R = inR[i] * boost;
                    if (noiseReduction > 0) { L *= (1 - noiseReduction * 0.5); R *= (1 - noiseReduction * 0.5); }
                    const level = Math.abs(L + R) * 0.5;
                    if (level > gateThresh) this.gateEnvelope = Math.min(1, this.gateEnvelope + 0.01); else this.gateEnvelope = Math.max(0, this.gateEnvelope - 0.001);
                    L *= this.gateEnvelope; R *= this.gateEnvelope;
                    L = L * eqMid + (L - L * 0.98) * eqTreble; R = R * eqMid + (R - R * 0.98) * eqTreble;
                    if (distortion > 0) { L = Math.tanh(L * (1 + distortion * 3)); R = Math.tanh(R * (1 + distortion * 3)); }
                    if (reverbAmt > 0.01) { L += this.reverbBuffer[this.reverbPos] * reverbAmt * 0.5; R += this.reverbBuffer[(this.reverbPos + 12000) % 24000] * reverbAmt * 0.5; this.reverbBuffer[this.reverbPos] = (L + R) * 0.3; this.reverbPos = (this.reverbPos + 1) % 24000; }
                    this.bufL[this.writePos] = L; this.bufR[this.writePos] = R; this.writePos = (this.writePos + 1) % this.bufSize;
                    L = this.bufL[Math.floor(this.readPos)]; R = this.bufR[Math.floor(this.readPos)]; this.readPos = (this.readPos + pitch) % this.bufSize;
                    if (width > 0.01) { const mid = (L + R) * 0.5; const side = (L - R) * 0.5 * (1 + width); L = mid + side; R = mid - side; }
                    L *= gain * (1 - ducking * 0.7); R *= gain * (1 - ducking * 0.7);
                    outL[i] = Math.tanh(L); if (output[1]) outR[i] = Math.tanh(R);
                }
                if (Math.random() < 0.01) { let peak=0; for(let i=0;i<len;i++) peak=Math.max(peak,Math.abs(outL[i])); this.port.postMessage({ peak }); }
                return true;
            }
        }
        registerProcessor('fiona-engine', FionaEngine);
    `;

  const FionaParams = { masterGain: 0, inputBoost: 0, width: 0, pitch: 50, reverb: 0, eqBass: 50, eqMid: 50, eqTreble: 50, gateThreshold: -40, formant: 1.0, distortion: 0, noiseReduction: 0, vadEnabled: false, vadThreshold: -45, duckingEnabled: false, duckingReduction: 10, voiceProfile: 'auto' };
  function syncFionaFromStore() {
    const s = cfg().slider;
    const clear = cfg().clear;
    FionaParams.masterGain = Number.isFinite(Number(store.masterGain)) ? Number(store.masterGain) : Math.round(s * 0.9);
    FionaParams.inputBoost = Number.isFinite(Number(store.inputBoost)) ? Number(store.inputBoost) : Math.round(s * 1.0);
    FionaParams.width = Number(store.width) ?? 0;
    FionaParams.pitch = Number(store.pitch) ?? 50;
    FionaParams.reverb = Number(store.reverb) ?? 0;
    FionaParams.eqBass = Number(store.eqBass) ?? 50;
    FionaParams.eqMid = Number(store.eqMid) ?? 50;
    FionaParams.eqTreble = Number(store.eqTreble) ?? 50;
    FionaParams.gateThreshold = Number(store.gateThreshold) ?? -40;
    FionaParams.formant = (Number(store.formant) ?? 100) / 100;
    FionaParams.noiseReduction = Number(store.noiseReduction) ?? 0;
    FionaParams.vadEnabled = !!store.vadEnabled;
    FionaParams.vadThreshold = Number(store.vadThreshold) ?? -45;
    FionaParams.duckingEnabled = !!store.duckingEnabled;
    FionaParams.duckingReduction = Number(store.duckingReduction) ?? 10;
    FionaParams.voiceProfile = store.voiceProfile ?? 'auto';
    if (clear) {
      FionaParams.distortion = 0;
    } else {
      FionaParams.distortion = Number.isFinite(Number(store.distortion)) ? Number(store.distortion) : s;
    }
    // voice changer preset overrides pitch/formant/distortion/reverb
    const vp = VOICE_PRESETS[store.voiceChanger];
    if (vp && store.voiceChanger !== 'none') {
      FionaParams.pitch = vp.pitch;
      FionaParams.formant = vp.formant;
      FionaParams.distortion = vp.distortion * 100;
      FionaParams.reverb = vp.reverb;
    }
  }
  syncFionaFromStore();
  function dbToGain(db) { return Math.pow(10, db / 20); }

  let nativeGUM = null; let gumPatched = false; let fionaNode = null; let fionaCtx = null;

  const ensureContext = async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!fionaCtx) {
      try {
        fionaCtx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
        window.DiscordContext = fionaCtx;
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await fionaCtx.audioWorklet.addModule(url);
      } catch (e) { logger.info("fiona ctx failed " + e); return null; }
    }
    if (fionaCtx.state === 'suspended') { try { await fionaCtx.resume(); } catch {} }
    return fionaCtx;
  };

  const updateFionaNode = () => {
    if (!fionaNode || !fionaCtx) return;
    syncFionaFromStore();
    const p = fionaNode.parameters; const t = fionaCtx.currentTime;
    const upd = {
      gain: dbToGain(FionaParams.masterGain),
      boost: dbToGain(FionaParams.inputBoost * 0.2),
      width: FionaParams.width / 100,
      pitch: Math.pow(2, (FionaParams.pitch - 50) / 25),
      reverb: FionaParams.reverb / 100,
      eqBass: FionaParams.eqBass / 50,
      eqMid: FionaParams.eqMid / 50,
      eqTreble: FionaParams.eqTreble / 50,
      gateThreshold: dbToGain(FionaParams.gateThreshold),
      formant: FionaParams.formant,
      distortion: FionaParams.distortion / 100,
      noiseReduction: FionaParams.noiseReduction / 100,
      ducking: FionaParams.duckingEnabled ? FionaParams.duckingReduction / 20 : 0
    };
    Object.entries(upd).forEach(([k, v]) => { try { if (p.has(k)) p.get(k).setTargetAtTime(v, t, 0.05); } catch {} });
  };

  const patchGetUserMedia = () => {
    try {
      const nav = (typeof navigator !== 'undefined' ? navigator : null) ?? window?.navigator ?? global?.navigator ?? null;
      const md = nav?.mediaDevices;
      if (!md || !md.getUserMedia) return false;
      if (md._fionaPatched) return true;
      nativeGUM = md.getUserMedia.bind(md);
      md.getUserMedia = async (constraints) => {
        if (constraints?.audio) constraints.audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        const stream = await nativeGUM(constraints);
        if (!constraints?.audio || !cfg().enabled) return stream;
        try {
          const ctx = await ensureContext();
          if (!ctx) return stream;
          const source = ctx.createMediaStreamSource(stream);
          const dest = ctx.createMediaStreamDestination();
          fionaNode = new AudioWorkletNode(ctx, 'fiona-engine');
          source.connect(fionaNode); fionaNode.connect(dest);
          syncFionaFromStore(); updateFionaNode();
          logger.info("fiona injected stream, gain " + cfg().slider);
          return dest.stream;
        } catch (e) { logger.info("fiona inject failed " + e); return stream; }
      };
      md._fionaPatched = true; gumPatched = true;
      logger.info("patched getUserMedia with fiona");
      return true;
    } catch (e) { logger.info("gum patch failed " + e); return false; }
  };

  let patches = []; let fluxUnsub = null; const saveOrig = []; let voiceRetry = null;

  const applyOptions = (options) => {
    if (!options) return options;
    if (options.encodingVoiceBitRate != null) options.encodingVoiceBitRate = cfg().bitrate;
    const enc = options.audioEncoder;
    if (enc) {
      enc.channels = cfg().stereo ? 2 : 1; enc.rate = 48000;
      const params = { ...enc.params, usedtx: "0", useinbandfec: "0", maxaveragebitrate: String(cfg().bitrate) };
      if (cfg().stereo) params.stereo = "1";
      if (cfg().raw) { const off = ["nr","ns","agc","aec","cn","tx","highpass"]; for (const k of off) params[k] = "0"; }
      enc.params = params;
    }
    if (options.fec !== undefined) options.fec = false;
    return options;
  };
  const normalizeArgs = (a, b) => (Array.isArray(b) ? b : Array.isArray(a) ? a : [a]);
  const hookTransport = () => {
    const conn = findByProps("setTransportOptions");
    if (conn) { const undo = patcher.before("setTransportOptions", conn, (a, b) => { if (!cfg().enabled) return; const args = normalizeArgs(a, b); if (args?.[0]) args[0] = applyOptions(args[0]); }); if (undo) patches.push(undo); logger.info("patched setTransportOptions"); }
  };
  const hookFlux = () => { if (!FluxDispatcher?.subscribe) return; fluxUnsub = FluxDispatcher.subscribe("MEDIA_ENGINE_SET_TRANSPORT_OPTIONS", (e) => { if (!cfg().enabled) return; if (e?.transportOptions) e.transportOptions = applyOptions(e.transportOptions); }); logger.info("intercepted flux"); };

  const patchMicSettings = () => {
    const tryPatch = () => {
      try {
        const Forms = ui.components?.Forms ?? (() => { try { return findByProps("FormRow", "FormSwitchRow", "FormSection"); } catch { return null; } })();
        const RN = metro.common?.ReactNative; if (!Forms || !React || !RN) return false;
        const E = React.createElement;
        function BoostSection() {
          const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
          const slider = cfg().slider;
          const SliderComp = Forms.Slider ?? Forms.FormSlider ?? (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN.Slider ?? null;
          const mkSwitch = (title, key) => E(Forms.FormSwitchRow ?? Forms.FormRow, { label: title, value: !!store[key], onValueChange: (v) => { store[key] = !!v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } });
          const sliderEl = SliderComp ? E(RN.View, { style: { paddingHorizontal: 16, paddingVertical: 8 } }, E(RN.Text, { style: { color: "#fff", marginBottom: 8, fontWeight: "700" } }, `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x) — ${cfg().clear ? "CLEAN" : "DISTORTED"}`), E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } })) : E(Forms.FormRow, { label: `Volume: ${slider}/90` });
          const Section = Forms.FormSection || (({ children, title }) => E(RN.View, null, title ? E(RN.Text, { style: { fontWeight: "700", padding: 16 } }, title) : null, children));
          return E(Section, { title: "Fiona Audio — Mic" }, mkSwitch("Boost enabled", "enabled"), mkSwitch("Clear audio", "clear"), sliderEl, E(Forms.FormRow, { label: "Open full Fiona panel in Plugins → Fiona Audio" }));
        }
        const makeSection = () => E(BoostSection, null);
        const candidates = []; const tryFind = (fn) => { try { const r = fn(); if (r) candidates.push(r); } catch {} };
        tryFind(() => metro.findByName("VoiceSettings", false));
        tryFind(() => { try { return metro.findByDisplayName("VoiceSettings"); } catch { return null; } });
        tryFind(() => findByProps("VoiceSettings")); tryFind(() => findByProps("setNoiseSuppression"));
        for (const mod of candidates) {
          const target = mod?.default ? mod : mod;
          if (target && typeof target.default === "function") {
            try {
              const undo = patcher.after("default", target, (args, ret) => { try { if (!ret || !ret.props) return ret; const ch = ret.props.children; if (Array.isArray(ch)) ch.unshift(makeSection()); else if (ch) ret.props.children = [makeSection(), ch]; else ret.props.children = makeSection(); } catch (e) { logger.info("append failed " + e); } return ret; });
              if (undo) { patches.push(undo); logger.info("patched mic settings"); return true; }
            } catch (e) { logger.info("voice patch failed " + e); }
          }
        }
        return false;
      } catch (e) { logger.info("patchMicSettings failed " + e); return false; }
    };
    if (tryPatch()) return;
    let attempts = 0; if (voiceRetry) clearInterval(voiceRetry);
    voiceRetry = setInterval(() => { if (tryPatch() || ++attempts > 15) { clearInterval(voiceRetry); voiceRetry = null; } }, 1000);
  };

  const createFloating = () => {
    try {
      const RN = metro.common?.ReactNative;
      if (!RN || !React) return false;
      const E = React.createElement;
      const { View, Text, TouchableOpacity } = RN;
      let AppMod = null;
      try { AppMod = metro.findByName("App", false); } catch {}
      if (!AppMod) try { AppMod = metro.findByDisplayName("App"); } catch {}
      if (!AppMod) try { AppMod = findByProps("App"); } catch {}
      if (!AppMod || typeof AppMod.default !== "function") return false;
      const Floating = () => {
        const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
        const slider = cfg().slider;
        const [open, setOpen] = React.useState(false);
        const SliderComp = (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN.Slider ?? null;
        return E(View, { style: { position: "absolute", top: 50, right: 12, zIndex: 9999, alignItems: "flex-end" } },
          E(TouchableOpacity, { onPress: () => setOpen(!open), activeOpacity: 0.85, style: { backgroundColor: "#0a0a0f", borderWidth: 1, borderColor: "rgba(100,40,180,0.35)", borderRadius: 100, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center" } },
            E(View, { style: { width: 10, height: 10, borderRadius: 5, backgroundColor: cfg().enabled ? "#7a3adf" : "rgba(100,40,180,0.3)", marginRight: 8 } }),
            E(Text, { style: { color: "#fff", fontWeight: "700", fontSize: 12 } }, "Fiona"),
            E(Text, { style: { color: "rgba(180,130,255,0.7)", fontSize: 10, marginLeft: 8 } }, slider + "/90")
          ),
          open ? E(View, { style: { marginTop: 8, width: 300, backgroundColor: "#0d0d1a", borderWidth: 1, borderColor: "rgba(100,40,180,0.2)", borderRadius: 16, padding: 12 } },
            E(Text, { style: { color: "#c8aaff", fontWeight: "700", fontSize: 13, marginBottom: 10 } }, "Fiona — same colours"),
            SliderComp ? E(View, { style: { marginBottom: 10 } }, E(Text, { style: { color: "#fff", marginBottom: 6, fontSize: 12 } }, `Volume: ${slider} / 90`), E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } })) : E(Text, { style: { color: "#fff" } }, `Volume ${slider}/90`),
            E(TouchableOpacity, { onPress: () => { store.clear = !store.clear; syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, style: { backgroundColor: store.clear ? "rgba(100,40,180,0.25)" : "#1a1a2a", borderWidth: 1, borderColor: store.clear ? "rgba(100,40,180,0.5)" : "rgba(100,40,180,0.15)", borderRadius: 8, padding: 10, alignItems: "center", marginTop: 6 } }, E(Text, { style: { color: store.clear ? "#c8aaff" : "#aaa", fontWeight: "600" } }, store.clear ? "Clear: ON" : "Clear: OFF")),
            E(TouchableOpacity, { onPress: () => { store.enabled = !store.enabled; syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, style: { backgroundColor: cfg().enabled ? "rgba(100,40,180,0.2)" : "#222", borderWidth: 1, borderColor: "rgba(100,40,180,0.2)", borderRadius: 8, padding: 10, alignItems: "center", marginTop: 6 } }, E(Text, { style: { color: cfg().enabled ? "#c8aaff" : "#888" } }, cfg().enabled ? "Boost: ON" : "Boost: OFF"))
          ) : null
        );
      };
      const undo = patcher.after("default", AppMod, (args, ret) => {
        try { return E(View, { style: { flex: 1 } }, ret, E(Floating, null)); } catch { return ret; }
      });
      if (undo) { patches.push(undo); logger.info("floating Fiona injected"); return true; }
    } catch (e) { logger.info("floating failed " + e); }
    return false;
  };

  const buildSettings = () => {
    try {
      if (!React) return () => null;
      const E = React.createElement;
      const Forms = ui.components?.Forms ?? (() => { try { return findByProps("FormRow", "FormSwitchRow", "FormSection"); } catch { return null; } })();
      const RN = metro.common?.ReactNative;
      if (!Forms || !Forms.FormRow) {
        if (RN && RN.View) {
          const { View, Text, Switch, ScrollView } = RN;
          return () => {
            const [, fu] = React.useReducer((x) => x + 1, 0);
            const mkSw = (t, k) => E(View, { style: { flexDirection: "row", justifyContent: "space-between", padding: 12 } }, E(Text, { style: { color: "#fff" } }, t), E(Switch, { value: !!store[k], onValueChange: (v) => { store[k] = !!v; syncFionaFromStore(); updateFionaNode(); fu(); } }));
            return E(ScrollView, null, E(Text, { style: { color: "#fff", padding: 16, fontWeight: "700" } }, `Fiona Audio — slider ${cfg().slider}/90`), mkSw("Boost", "enabled"), mkSw("Clear", "clear"));
          };
        }
        return () => null;
      }
      const { FormSection, FormRow, FormSwitchRow, FormText } = Forms;
      const Section = FormSection || (({ children, title }) => E(RN?.View ?? "View", null, title ? E(RN?.Text ?? "Text", { style: { fontWeight: "700", padding: 16 } }, title) : null, children));
      const T = FormText || FormRow;

      return () => {
        const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
        const [tab, setTab] = React.useState("main");
        const SliderComp = Forms.Slider ?? Forms.FormSlider ?? (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN?.Slider ?? null;

        const mkSlider = (id, label, min, max, val) => {
          const comp = SliderComp ? E(SliderComp, { value: Number(val), minimumValue: min, maximumValue: max, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store[id] = Math.round(Number(nv)); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } }) : E(FormRow, { label: `${label}: ${val}` });
          return E(RN?.View ?? "View", { style: { paddingHorizontal: 16, paddingVertical: 6 } }, E(RN?.Text ?? "Text", { style: { color: "#fff", marginBottom: 4 } }, `${label}: ${val}`), comp);
        };
        const mkSwitch = (label, key) => E(FormSwitchRow ?? FormRow, { label, value: !!store[key], onValueChange: (v) => { store[key] = !!v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } });

        const TabBar = () => E(RN?.View ?? "View", { style: { flexDirection: "row", flexWrap: "wrap", padding: 8, gap: 6 } }, ["main","eq","voice","advanced","presets"].map((t) => E(FormRow, { key: t, label: t.toUpperCase(), trailing: E(RN?.View ?? "View", { style: { backgroundColor: tab === t ? "#7a3adf" : "#333", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 } }, E(RN?.Text ?? "Text", { style: { color: "#fff", fontSize: 11 }, onPress: () => setTab(t) }, t)) })));

        let pane = null;
        if (tab === "main") {
          pane = E(RN?.View ?? "View", null,
            mkSlider("gain", "VOLUME (0-90) HIGH GAIN", 0, 90, cfg().slider),
            mkSwitch("Boost enabled", "enabled"), mkSwitch("Clear (no distortion)", "clear"), mkSwitch("Raw mode", "raw"), mkSwitch("Stereo + max bitrate", "stereo"),
            mkSlider("masterGain", "Master Gain", 0, 100, store.masterGain), mkSlider("inputBoost", "Pre-Amp", 0, 100, store.inputBoost), mkSlider("width", "Stereo Width", 0, 100, store.width)
          );
        } else if (tab === "eq") {
          pane = E(RN?.View ?? "View", null, mkSlider("eqBass", "Bass", 0, 100, store.eqBass), mkSlider("eqMid", "Mid", 0, 100, store.eqMid), mkSlider("eqTreble", "Treble", 0, 100, store.eqTreble));
        } else if (tab === "voice") {
          const voiceOpts = Object.keys(VOICE_PRESETS);
          const profileOpts = Object.keys(VOICE_PROFILES);
          pane = E(RN?.View ?? "View", null,
            E(FormRow, { label: "Voice Type", trailing: E(RN?.Text ?? "Text", { style: { color: "#7af" } }, String(store.voiceChanger)) }),
            ...voiceOpts.map((v) => E(FormRow, { key: v, label: v, trailing: E(RN?.View ?? "View", { style: { backgroundColor: store.voiceChanger === v ? "#7a3adf" : "#333", borderRadius: 6, padding: 6 } }, E(RN?.Text ?? "Text", { style: { color: "#fff" }, onPress: () => { store.voiceChanger = v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } }, v === store.voiceChanger ? "✓" : "○")) })),
            E(FormRow, { label: "Voice Profile", trailing: E(RN?.Text ?? "Text", { style: { color: "#7af" } }, String(store.voiceProfile)) }),
            ...profileOpts.map((p) => E(FormRow, { key: p, label: p, trailing: E(RN?.View ?? "View", { style: { backgroundColor: store.voiceProfile === p ? "#7a3adf" : "#333", borderRadius: 6, padding: 6 } }, E(RN?.Text ?? "Text", { style: { color: "#fff" }, onPress: () => { store.voiceProfile = p; const prof = VOICE_PROFILES[p]; if (prof) { Object.keys(prof).forEach((k) => { store[k] = prof[k]; }); } syncFionaFromStore(); updateFionaNode(); forceUpdate(); } }, p === store.voiceProfile ? "✓" : "○")) })),
            mkSlider("pitch", "Pitch", 0, 100, store.pitch), mkSlider("formant", "Formant", 50, 200, store.formant), mkSlider("distortion", "Distortion", 0, 100, store.distortion), mkSlider("reverb", "Reverb", 0, 100, store.reverb)
          );
        } else if (tab === "advanced") {
          pane = E(RN?.View ?? "View", null,
            mkSlider("gateThreshold", "Gate Threshold", -60, 0, store.gateThreshold),
            mkSlider("noiseReduction", "Noise Reduction", 0, 100, store.noiseReduction),
            mkSwitch("VAD", "vadEnabled"), mkSlider("vadThreshold", "VAD Threshold", -60, 0, store.vadThreshold),
            mkSwitch("Audio Ducking", "duckingEnabled"), mkSlider("duckingReduction", "Duck Amount", 0, 30, store.duckingReduction)
          );
        } else if (tab === "presets") {
          pane = E(RN?.View ?? "View", null, ...Object.keys(PRESETS).map((n) => E(FormRow, { key: n, label: n, onPress: () => { const defs = { masterGain:0,inputBoost:0,width:0,pitch:50,reverb:0,eqBass:50,eqMid:50,eqTreble:50,gateThreshold:-40,formant:100,distortion:0,noiseReduction:0 }; Object.assign(store, defs, PRESETS[n]); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } })));
        }

        return E(RN?.ScrollView ? RN.ScrollView : RN?.View ?? "View", { style: { flex: 1 } },
          E(Section, { title: "Fiona Audio — Full" }, E(T, { style: { paddingHorizontal: 16, paddingTop: 8, color: "#aaa" } }, `Fiona worklet ${gumPatched ? "ACTIVE" : "fallback"} — slider ${cfg().slider}/90`)),
          E(TabBar, null),
          pane
        );
      };
    } catch (e) { logger.info("settings build failed " + e); return () => null; }
  };

  return {
    onLoad() {
      try { logger.info("Fiona Audio plugin starting"); } catch {}
      try { patchGetUserMedia(); } catch (e) { try { logger.info("gum failed " + e); } catch {} }
      try { hookTransport(); } catch (e) { try { logger.info("transport failed " + e); } catch {} }
      try { hookFlux(); } catch (e) { try { logger.info("flux failed " + e); } catch {} }
      try { patchMicSettings(); } catch (e) { try { logger.info("mic patch failed " + e); } catch {} }
      try { createFloating(); } catch (e) { try { logger.info("floating failed " + e); } catch {} }
      try { syncFionaFromStore(); } catch {}
      try { updateFionaNode(); } catch {}
      try { logger.info("Fiona Audio ready — slider " + cfg().slider); } catch {}
    },
    onUnload() {
      for (const u of patches) try { u(); } catch {}
      patches = []; if (voiceRetry) { try { clearInterval(voiceRetry); } catch {} voiceRetry = null; }
      if (fluxUnsub) try { fluxUnsub(); } catch {} fluxUnsub = null;
      for (const r of saveOrig) try { r(); } catch {} saveOrig.length = 0;
      if (gumPatched && nativeGUM) { try { const nav = (typeof navigator !== 'undefined' ? navigator : null) ?? window?.navigator ?? global?.navigator ?? null; if (nav?.mediaDevices) nav.mediaDevices.getUserMedia = nativeGUM; } catch {} nativeGUM = null; gumPatched = false; }
      if (fionaCtx) try { fionaCtx.close(); } catch {} fionaCtx = null; fionaNode = null;
      logger.info("Fiona stopped");
    },
    settings: buildSettings(),
  };
})()
