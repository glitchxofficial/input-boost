(() => {
  const { metro, patcher, ui, plugin, logger } = vendetta;
  const { findByProps } = metro;
  const FluxDispatcher = metro.common?.FluxDispatcher;
  const React = metro.common?.React;

  const store = plugin?.storage ?? {};
  if (store.gain == null) store.gain = 90;
  if (store.bitrate == null) store.bitrate = 512000;
  if (store.raw == null) store.raw = true;
  if (store.stereo == null) store.stereo = true;
  if (store.enabled == null) store.enabled = true;
  if (store.clear == null) store.clear = false;

  const toSlider = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n)) return 90;
    if (n > 0 && n <= 10) n = n * 10;
    return Math.max(0, Math.min(90, Math.round(n)));
  };
  const cfg = () => {
    const slider = toSlider(store.gain);
    const gain = slider / 10;
    const clear = store.clear === true;
    return { enabled: store.enabled !== false, clear, slider, gain, bitrate: store.bitrate === 384000 ? 384000 : 512000, raw: clear ? false : store.raw !== false, stereo: store.stereo !== false };
  };

  // ===== Fiona Audio Engine (web) =====
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
                const input = inputs[0];
                const output = outputs[0];
                if (!input || input.length === 0) return true;
                const gain = parameters.gain[0];
                const boost = parameters.boost[0];
                const width = parameters.width[0];
                const pitch = parameters.pitch[0];
                const reverbAmt = parameters.reverb[0];
                const eqMid = parameters.eqMid[0];
                const eqTreble = parameters.eqTreble[0];
                const gateThresh = parameters.gateThreshold[0];
                const distortion = parameters.distortion[0];
                const noiseReduction = parameters.noiseReduction[0];
                const ducking = parameters.ducking[0];
                const inL = input[0];
                const inR = input[1] || input[0];
                const outL = output[0];
                const outR = output[1] || output[0];
                const len = inL.length;
                for (let i = 0; i < len; i++) {
                    let L = inL[i] * boost;
                    let R = inR[i] * boost;
                    if (noiseReduction > 0) { L *= (1 - noiseReduction * 0.5); R *= (1 - noiseReduction * 0.5); }
                    const level = Math.abs(L + R) * 0.5;
                    if (level > gateThresh) this.gateEnvelope = Math.min(1, this.gateEnvelope + 0.01);
                    else this.gateEnvelope = Math.max(0, this.gateEnvelope - 0.001);
                    L *= this.gateEnvelope; R *= this.gateEnvelope;
                    L = L * eqMid + (L - L * 0.98) * eqTreble;
                    R = R * eqMid + (R - R * 0.98) * eqTreble;
                    if (distortion > 0) { L = Math.tanh(L * (1 + distortion * 3)); R = Math.tanh(R * (1 + distortion * 3)); }
                    if (reverbAmt > 0.01) {
                        L += this.reverbBuffer[this.reverbPos] * reverbAmt * 0.5;
                        R += this.reverbBuffer[(this.reverbPos + 12000) % 24000] * reverbAmt * 0.5;
                        this.reverbBuffer[this.reverbPos] = (L + R) * 0.3;
                        this.reverbPos = (this.reverbPos + 1) % 24000;
                    }
                    this.bufL[this.writePos] = L; this.bufR[this.writePos] = R;
                    this.writePos = (this.writePos + 1) % this.bufSize;
                    L = this.bufL[Math.floor(this.readPos)]; R = this.bufR[Math.floor(this.readPos)];
                    this.readPos = (this.readPos + pitch) % this.bufSize;
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

  const FionaParams = {
    masterGain: 0, inputBoost: 0, width: 0, pitch: 50, reverb: 0, eqBass: 50, eqMid: 50, eqTreble: 50, gateThreshold: -40, formant: 1.0, distortion: 0, noiseReduction: 0
  };
  function syncFionaFromStore() {
    const s = cfg().slider;
    const clear = cfg().clear;
    if (clear) {
      FionaParams.masterGain = Math.round(s * 0.6);
      FionaParams.inputBoost = Math.round(s * 0.8);
      FionaParams.distortion = 0;
      FionaParams.noiseReduction = 0;
      FionaParams.reverb = 0;
      FionaParams.width = 0;
    } else {
      FionaParams.masterGain = Math.round(s * 0.9);
      FionaParams.inputBoost = Math.round(s * 1.0);
      FionaParams.distortion = Math.round(s * 1.0);
      FionaParams.reverb = Math.round(s * 0.2);
      FionaParams.width = 10;
    }
  }
  syncFionaFromStore();

  function dbToGain(db) { return Math.pow(10, db / 20); }

  let nativeGUM = null;
  let gumPatched = false;
  let fionaNode = null;
  let fionaAnalyser = null;
  let fionaCtx = null;
  let pendingResolvers = [];
  let ctxReady = false;

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
    const p = fionaNode.parameters;
    const t = fionaCtx.currentTime;
    const upd = {
      gain: dbToGain(FionaParams.masterGain),
      boost: dbToGain(FionaParams.inputBoost * 0.2),
      width: FionaParams.width / 100,
      pitch: Math.pow(2, (50 - 50) / 25),
      reverb: FionaParams.reverb / 100,
      eqBass: FionaParams.eqBass / 50,
      eqMid: FionaParams.eqMid / 50,
      eqTreble: FionaParams.eqTreble / 50,
      gateThreshold: dbToGain(FionaParams.gateThreshold),
      formant: FionaParams.formant,
      distortion: FionaParams.distortion / 100,
      noiseReduction: FionaParams.noiseReduction / 100,
      ducking: 0
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
          fionaAnalyser = ctx.createAnalyser(); fionaAnalyser.fftSize = 512;
          fionaNode = new AudioWorkletNode(ctx, 'fiona-engine');
          source.connect(fionaNode); fionaNode.connect(dest); fionaNode.connect(fionaAnalyser);
          syncFionaFromStore(); updateFionaNode();
          logger.info("fiona injected stream, gain " + cfg().slider);
          return dest.stream;
        } catch (e) { logger.info("fiona inject failed " + e); return stream; }
      };
      md._fionaPatched = true;
      gumPatched = true;
      logger.info("patched getUserMedia with fiona");
      return true;
    } catch (e) { logger.info("gum patch failed " + e); return false; }
  };

  let patches = [];
  let fluxUnsub = null;
  const saveOrig = [];
  let voiceRetry = null;

  const applyOptions = (options) => {
    if (!options) return options;
    if (options.encodingVoiceBitRate != null) options.encodingVoiceBitRate = cfg().bitrate;
    const enc = options.audioEncoder;
    if (enc) {
      enc.channels = cfg().stereo ? 2 : 1;
      enc.rate = 48000;
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
    if (conn) {
      const undo = patcher.before("setTransportOptions", conn, (a, b) => {
        if (!cfg().enabled) return;
        const args = normalizeArgs(a, b);
        if (args?.[0]) args[0] = applyOptions(args[0]);
      });
      if (undo) patches.push(undo);
      logger.info("patched setTransportOptions");
    }
    const me = findByProps("getMediaEngine");
    if (me?.getMediaEngine) {
      try { const eng = me.getMediaEngine(); if (eng) { const orig = eng.setTransportOptions?.bind(eng); if (orig) { eng.setTransportOptions = (opts)=> orig(applyOptions(opts)); } } } catch {}
    }
  };

  const hookVolumeSetters = () => {
    const setters = findByProps("setVolume");
    if (setters) {
      const names = Object.keys(setters).filter((k) => /volume|gain|input/i.test(k) && typeof setters[k] === "function");
      for (const name of names) {
        const undo = patcher.before(name, setters, (a, b) => { if (!cfg().enabled) return; const args = normalizeArgs(a,b); for(let i=0;i<args.length;i++) if(typeof args[i]==="number"&&args[i]>=0&&args[i]<=1.5) args[i]=Math.min(args[i]*cfg().gain,2); });
        if (undo) patches.push(undo);
      }
      if (names.length) logger.info("hooked volume setters: " + names.join(", "));
    }
  };

  const hookFlux = () => {
    if (!FluxDispatcher?.subscribe) return;
    fluxUnsub = FluxDispatcher.subscribe("MEDIA_ENGINE_SET_TRANSPORT_OPTIONS", (e) => {
      if (!cfg().enabled) return;
      if (e?.transportOptions) e.transportOptions = applyOptions(e.transportOptions);
    });
    logger.info("intercepted MEDIA_ENGINE_SET_TRANSPORT_OPTIONS");
  };

  const hookSetConnection = () => {
    const m = findByProps("setConnection", "setAudioEncoder");
    if (m) {
      for (const name of ["setConnection", "setTransportOptions"]) {
        if (typeof m[name] !== "function") continue;
        const undo = patcher.before(name, m, (a, b) => {
          if (!cfg().enabled) return;
          const args = normalizeArgs(a, b);
          if (args[0] && typeof args[0] === "object") args[0] = applyOptions(args[0]) ?? args[0];
        });
        if (undo) patches.push(undo);
      }
      logger.info("hooked setConnection");
    }
  };

  const patchMicSettings = () => {
    const tryPatch = () => {
      try {
        const Forms = ui.components?.Forms ?? (() => { try { return findByProps("FormRow", "FormSwitchRow", "FormSection"); } catch { return null; } })();
        const RN = metro.common?.ReactNative;
        if (!Forms || !React || !RN) return false;
        const E = React.createElement;
        function BoostSection() {
          const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
          const slider = cfg().slider;
          const SliderComp = Forms.Slider ?? Forms.FormSlider ?? (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN.Slider ?? null;
          const mkSwitch = (title, key) => E(Forms.FormSwitchRow ?? Forms.FormRow, { label: title, value: !!store[key], onValueChange: (v) => { store[key] = !!v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } });
          const sliderEl = SliderComp
            ? E(RN.View, { style: { paddingHorizontal: 16, paddingVertical: 8 } }, E(RN.Text, { style: { color: "#fff", marginBottom: 8, fontWeight: "700" } }, `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x) — ${cfg().clear ? "CLEAN" : "DISTORTED"} MAX at 90`), E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, onSlidingComplete: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } }))
            : E(Forms.FormRow, { label: `Volume: ${slider}/90` });
          const Section = Forms.FormSection || (({ children, title }) => E(RN.View, null, title ? E(RN.Text, { style: { fontWeight: "700", padding: 16 } }, title) : null, children));
          return E(Section, { title: "Input Boost — Mic (in Voice Settings)" }, mkSwitch("Boost enabled", "enabled"), mkSwitch("Clear audio", "clear"), mkSwitch("Raw mode (distortion)", "raw"), mkSwitch("Stereo + max bitrate", "stereo"), sliderEl);
        }
        const makeSection = () => E(BoostSection, null);
        const candidates = [];
        const tryFind = (fn) => { try { const r = fn(); if (r) candidates.push(r); } catch {} };
        tryFind(() => metro.findByName("VoiceSettings", false));
        tryFind(() => { try { return metro.findByDisplayName("VoiceSettings"); } catch { return null; } });
        tryFind(() => metro.findByName("VoiceAndVideoSettings", false));
        tryFind(() => findByProps("VoiceSettings"));
        tryFind(() => findByProps("setNoiseSuppression"));
        tryFind(() => findByProps("setNoiseSuppression", "setEchoCancellation"));
        tryFind(() => findByProps("VOICE_SETTINGS_PANEL"));
        tryFind(() => findByProps("inputMode", "noiseSuppression"));
        tryFind(() => findByProps("echoCancellation", "noiseCancellation"));
        if (candidates.length === 0) {
          try {
            const mods = vendetta.metro.modules ?? {};
            for (const k in mods) {
              const exp = mods[k]?.exports ?? mods[k];
              if (!exp || typeof exp !== 'object') continue;
              if (exp.default && typeof exp.default === 'function') {
                const s = String(exp.default);
                if (s.includes("noiseSuppression") || s.includes("VoiceSettings") || s.includes("inputMode")) candidates.push(exp);
              }
              if (exp.VoiceSettings) candidates.push(exp);
              if (candidates.length >= 3) break;
            }
          } catch {}
        }
        for (const mod of candidates) {
          const target = mod?.default ? mod : mod;
          if (target && typeof target.default === "function") {
            try {
              const undo = patcher.after("default", target, (args, ret) => {
                try {
                  if (!ret || !ret.props) return ret;
                  const ch = ret.props.children;
                  if (Array.isArray(ch)) ch.unshift(makeSection());
                  else if (ch) ret.props.children = [makeSection(), ch];
                  else ret.props.children = makeSection();
                } catch (e) { logger.info("mic settings append failed " + e); }
                return ret;
              });
              if (undo) { patches.push(undo); logger.info("patched mic settings (VoiceSettings)"); return true; }
            } catch (e) { logger.info("voice patch failed " + e); }
          }
        }
        return false;
      } catch (e) { logger.info("patchMicSettings failed " + e); return false; }
    };
    if (tryPatch()) return;
    let attempts = 0;
    if (voiceRetry) clearInterval(voiceRetry);
    voiceRetry = setInterval(() => {
      if (tryPatch() || ++attempts > 15) { clearInterval(voiceRetry); voiceRetry = null; if (attempts > 15) logger.info("mic settings patch: VoiceSettings not found, use plugin settings"); }
    }, 1000);
  };

  const FormOrRow = (...els) => els.some((e) => !!e);
  const TextEl = (ui2) => ui2.components?.Forms?.FormText || ui2.components?.FormRow || "Text";

  const buildSettings = () => {
    try {
      if (!React) return () => null;
      const E = React.createElement;
      const Forms = ui.components?.Forms ?? (() => { try { return findByProps("FormRow", "FormSwitchRow", "FormSection"); } catch { return null; } })();
      const RN = metro.common?.ReactNative;

      if (Forms && Forms.FormRow) {
        const { FormSection, FormRow, FormSwitchRow, FormInput, FormText } = Forms;
        const Section = FormSection || (({ children, title }) => E(RN?.View ?? "View", null, title ? E(RN?.Text ?? "Text", { style: { fontWeight: "700", padding: 16 } }, title) : null, children));
        const T = FormText || FormRow;
        const Row = FormRow;
        const SwitchRow = FormSwitchRow || FormRow;
        const InputComp = FormInput || RN?.TextInput || null;

        return () => {
          const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
          const rows = [];
          rows.push(E(Section, { title: "Input Boost — Fiona Engine" }, E(T, { variant: "text-md/semibold", style: { paddingHorizontal: 16, paddingTop: 8 } }, "Volume 0-90 — max 90 = 9.0x + distortion. Uses Fiona worklet + transport boost.")));

          const mkSwitch = (title, key) => E(SwitchRow, { label: title, value: !!store[key], onValueChange: (v) => { store[key] = !!v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } });
          const SliderComp = Forms.Slider ?? Forms.FormSlider ?? (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN?.Slider ?? null;
          const mkGain = () => {
            const slider = cfg().slider;
            const label = `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x) — ${cfg().clear ? "CLEAN" : "DISTORTED"} HIGH GAIN`;
            if (SliderComp) {
              return E(RN?.View ?? "View", { style: { paddingHorizontal: 16, paddingVertical: 12 } },
                E(RN?.Text ?? "Text", { style: { color: "#fff", marginBottom: 8, fontWeight: "700" } }, label),
                E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, onSlidingComplete: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, style: { width: "100%" } })
              );
            }
            if (!InputComp || InputComp === RN?.TextInput) {
              return E(Row, { label, trailing: E(RN.TextInput, { value: String(slider), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center" }, onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) { store.gain = Math.max(0, Math.min(90, Math.round(n))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } } }) });
            }
            return E(Row, { label, trailing: E(InputComp, { value: String(slider), keyboardType: "number-pad", onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) { store.gain = Math.max(0, Math.min(90, Math.round(n))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } } }) });
          };

          rows.push(mkSwitch("Boost enabled", "enabled"));
          rows.push(mkSwitch("Clear audio, no distortion", "clear"));
          rows.push(mkSwitch("Raw mode (kill AGC / noise suppression)", "raw"));
          rows.push(mkSwitch("Stereo + max bitrate", "stereo"));
          rows.push(mkGain());
          rows.push(E(T, { variant: "text-sm/medium", style: { paddingHorizontal: 16, paddingTop: 8, color: "#aaa" } }, gumPatched ? "Fiona worklet: ACTIVE (getUserMedia hooked)" : "Fiona worklet: fallback transport boost (no getUserMedia)"));
          return E(RN?.ScrollView ? RN.ScrollView : RN?.View ?? "View", { style: { flex: 1 } }, ...rows);
        };
      }

      if (RN && RN.View && RN.Text && RN.Switch) {
        const { View, Text, Switch, TextInput, ScrollView } = RN;
        const Container = ScrollView || View;
        return () => {
          const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
          const rowStyle = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#333" };
          const titleStyle = { fontSize: 16, color: "#fff", flex: 1, paddingRight: 12 };
          const mkSwitch = (title, key) => E(View, { style: rowStyle }, E(Text, { style: titleStyle }, title), E(Switch, { value: !!store[key], onValueChange: (v) => { store[key] = !!v; syncFionaFromStore(); updateFionaNode(); forceUpdate(); } }));
          const SliderComp = (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN.Slider ?? null;
          const mkGain = () => {
            const slider = cfg().slider;
            if (SliderComp) {
              return E(View, { style: { paddingHorizontal: 16, paddingVertical: 12 } },
                E(Text, { style: { ...titleStyle, marginBottom: 8, fontWeight: "700" } }, `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x) — HIGH GAIN`),
                E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); }, onSlidingComplete: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } })
              );
            }
            return E(View, { style: rowStyle }, E(Text, { style: titleStyle }, `Volume: ${slider}/90`), E(TextInput, { value: String(slider), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center", color: "#fff" }, onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) { store.gain = Math.max(0, Math.min(90, Math.round(n))); syncFionaFromStore(); updateFionaNode(); forceUpdate(); } } }));
          };
          return E(Container, { style: { flex: 1, paddingTop: 8 } },
            E(View, { style: { padding: 16, backgroundColor: "#222", borderRadius: 8, margin: 16 } }, E(Text, { style: { color: "#aaa", fontSize: 13 } }, "Volume 0-90 slider — instantly changes Fiona gain. Both clean & distorted up to 90.")),
            mkSwitch("Boost enabled", "enabled"),
            mkSwitch("Clear audio, no distortion", "clear"),
            mkSwitch("Raw mode (kill AGC / noise suppression)", "raw"),
            mkSwitch("Stereo + max bitrate", "stereo"),
            mkGain(),
            E(View, { style: { padding: 16 } }, E(Text, { style: { color: gumPatched ? "#7af" : "#fa5", fontSize: 12 } }, gumPatched ? "Fiona worklet: ACTIVE" : "Fiona worklet: fallback"))
          );
        };
      }

      return () => E(TextEl(ui), { style: {} }, "Settings UI unavailable");
    } catch (e) {
      logger.info("settings build failed: " + e);
      return () => null;
    }
  };

  return {
    onLoad() {
      logger.info("Input Boost (Fiona) starting, slider " + cfg().slider);
      patchGetUserMedia();
      try { hookTransport(); } catch (e) { logger.info("transport hook failed: " + e); }
      try { hookVolumeSetters(); } catch (e) { logger.info("volume hook failed: " + e); }
      try { hookFlux(); } catch (e) { logger.info("flux hook failed: " + e); }
      try { hookSetConnection(); } catch (e) { logger.info("connection hook failed: " + e); }
      try { patchMicSettings(); } catch (e) { logger.info("mic settings patch failed: " + e); }
      syncFionaFromStore(); updateFionaNode();
    },
    onUnload() {
      for (const undo of patches) { try { undo(); } catch {} }
      patches = [];
      if (voiceRetry) { try { clearInterval(voiceRetry); } catch {} voiceRetry = null; }
      if (fluxUnsub) { try { fluxUnsub(); } catch {} fluxUnsub = null; }
      for (const restore of saveOrig) { try { restore(); } catch {} }
      saveOrig.length = 0;
      if (gumPatched && nativeGUM) { try { const nav = (typeof navigator !== 'undefined' ? navigator : null) ?? window?.navigator ?? global?.navigator ?? null; if (nav?.mediaDevices) nav.mediaDevices.getUserMedia = nativeGUM; } catch {} nativeGUM = null; gumPatched = false; }
      if (fionaCtx) { try { fionaCtx.close(); } catch {} fionaCtx = null; fionaNode = null; }
      logger.info("Input Boost stopped");
    },
    settings: buildSettings(),
  };
})()
