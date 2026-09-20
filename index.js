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
    if (!Number.isFinite(n)) return 40;
    if (n > 0 && n <= 10) n = n * 10;
    return Math.max(0, Math.min(90, Math.round(n)));
  };
  const cfg = () => {
    const slider = toSlider(store.gain);
    const gain = slider / 10;
    const clear = store.clear === true;
    return {
      enabled: store.enabled !== false,
      clear,
      slider,
      gain,
      bitrate: store.bitrate === 384000 ? 384000 : 512000,
      raw: clear ? false : store.raw !== false,
      stereo: store.stereo !== false,
    };
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
      const params = {
        ...enc.params,
        usedtx: "0",
        useinbandfec: "0",
        maxaveragebitrate: String(cfg().bitrate),
      };
      if (cfg().stereo) params.stereo = "1";
      if (cfg().raw) {
        const off = ["nr", "ns", "agc", "aec", "cn", "tx", "highpass"];
        for (const k of off) params[k] = "0";
      }
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
      const undo = patcher.before("getMediaEngine", me, () => {});
      if (undo) patches.push(undo);
      try {
        boostMediaEngine(me.getMediaEngine());
      } catch (e) {
        logger.info("media engine boost skipped: " + e);
      }
    }
  };

  const boostMediaEngine = (engine) => {
    if (!engine) return;
    const gainHooks = [
      "setInputVolume",
      "setMicVolume",
      "setInputGain",
      "setMicGain",
      "setAudioInputGain",
      "setLocalVolume",
    ];
    for (const name of gainHooks) {
      if (typeof engine[name] !== "function") continue;
      const orig = engine[name].bind(engine);
      saveOrig.push(() => {
        engine[name] = orig;
      });
      engine[name] = (...args) => {
        const c = cfg();
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === "number" && args[i] >= 0 && args[i] <= 1.5) {
            args[i] = Math.min(args[i] * c.gain, 2);
          }
        }
        return orig(...args);
      };
      logger.info("boosted input hook: " + name + " x" + cfg().gain);
    }
    const proto = Object.getPrototypeOf(engine);
    if (proto) boostMediaEngine(proto);
  };

  const numericArgs = (a, b) => {
    const args = normalizeArgs(a, b);
    return args.map((x) => {
      if (typeof x === "number" && Number.isFinite(x)) return x;
      if (x && typeof x === "object" && "value" in x && typeof x.value === "number") {
        x.value = Math.min(x.value * cfg().gain, 2);
      }
      return x;
    });
  };

  const hookVolumeSetters = () => {
    const setters = findByProps("setVolume");
    if (setters) {
      const names = Object.keys(setters).filter((k) =>
        /volume|gain|input/i.test(k) && typeof setters[k] === "function"
      );
      for (const name of names) {
        const undo = patcher.before(name, setters, (a, b) => {
          if (!cfg().enabled) return;
          numericArgs(a, b);
        });
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

  const rematch = (args) => {
    const real = [];
    for (const a of args) {
      if (typeof a === "object" && a !== null) {
        const copy = { ...a };
        applyOptions(copy);
        real.push(copy);
      } else real.push(a);
    }
    return real;
  };

  const hookSetConnection = () => {
    const m = findByProps("setConnection", "setAudioEncoder");
    if (m) {
      for (const name of ["setConnection", "setTransportOptions"]) {
        if (typeof m[name] !== "function") continue;
        const undo = patcher.before(name, m, (a, b) => {
          if (!cfg().enabled) return;
          const args = normalizeArgs(a, b);
          if (args[0] && typeof args[0] === "object") {
            args[0] = applyOptions(args[0]) ?? args[0];
          }
        });
        if (undo) patches.push(undo);
      }
      logger.info("hooked setConnection / setAudioEncoder");
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
          const mkSwitch = (title, key) => E(Forms.FormSwitchRow ?? Forms.FormRow, { label: title, value: !!store[key], onValueChange: (v) => { store[key] = !!v; forceUpdate(); } });
          const sliderEl = SliderComp
            ? E(RN.View, { style: { paddingHorizontal: 16, paddingVertical: 8 } }, E(RN.Text, { style: { color: "#fff", marginBottom: 8 } }, `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x) — MAX at 90`), E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); forceUpdate(); } }))
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
        // scan modules if still none — brute force over metro.modules
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
                  if (Array.isArray(ch)) ch.push(makeSection());
                  else if (ch) ret.props.children = [ch, makeSection()];
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
    // retry for lazy-loaded settings (user hasn't opened Voice & Video yet)
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
          const rows = [];
          rows.push(E(Section, { title: "Input Boost" }, E(T, { variant: "text-md/semibold", style: { paddingHorizontal: 16, paddingTop: 8 } }, "Hot mic: Clear = loud & clean (1.5x), Raw = overdriven & distorted (up to 10x).")));

          const mkSwitch = (title, key) => E(SwitchRow, { label: title, value: !!store[key], onValueChange: (v) => { store[key] = !!v; } });
          const SliderComp = Forms.Slider ?? Forms.FormSlider ?? (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN?.Slider ?? null;
          const mkGain = () => {
            const slider = cfg().slider;
            const label = `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x)`;
            if (SliderComp) {
              return E(RN?.View ?? View ?? "View", { style: { paddingHorizontal: 16, paddingVertical: 12 } },
                E(RN?.Text ?? Text ?? "Text", { style: { color: "#fff", marginBottom: 8 } }, label),
                E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); }, style: { width: "100%" } })
              );
            }
            if (!InputComp || InputComp === RN?.TextInput) {
              return E(Row, { label, trailing: E(RN.TextInput, { value: String(slider), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center" }, onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) store.gain = Math.max(0, Math.min(90, Math.round(n))); } }) });
            }
            return E(Row, { label, trailing: E(InputComp, { value: String(slider), keyboardType: "number-pad", onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) store.gain = Math.max(0, Math.min(90, Math.round(n))); } }) });
          };

          rows.push(mkSwitch("Boost enabled", "enabled"));
          rows.push(mkSwitch("Clear audio, no distortion", "clear"));
          rows.push(mkSwitch("Raw mode (kill AGC / noise suppression)", "raw"));
          rows.push(mkSwitch("Stereo + max bitrate", "stereo"));
          rows.push(mkGain());
          return E(RN?.ScrollView ? RN.ScrollView : RN?.View ?? "View", { style: { flex: 1 } }, ...rows);
        };
      }

      if (RN && RN.View && RN.Text && RN.Switch) {
        const { View, Text, Switch, TextInput, ScrollView } = RN;
        const Container = ScrollView || View;
        return () => {
          const rowStyle = { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#333" };
          const titleStyle = { fontSize: 16, color: "#fff", flex: 1, paddingRight: 12 };
          const mkSwitch = (title, key) => E(View, { style: rowStyle }, E(Text, { style: titleStyle }, title), E(Switch, { value: !!store[key], onValueChange: (v) => { store[key] = !!v; } }));
          const SliderComp = (() => { try { const m = findByProps("Slider"); return m?.Slider ?? m ?? null; } catch { return null; } })() ?? RN.Slider ?? null;
          const mkGain = () => {
            const slider = cfg().slider;
            if (SliderComp) {
              return E(View, { style: { paddingHorizontal: 16, paddingVertical: 12 } },
                E(Text, { style: { ...titleStyle, marginBottom: 8 } }, `Volume: ${slider} / 90 (${(slider / 10).toFixed(1)}x)`),
                E(SliderComp, { value: slider, minimumValue: 0, maximumValue: 90, step: 1, onValueChange: (v) => { const nv = Array.isArray(v) ? v[0] : v; store.gain = Math.max(0, Math.min(90, Math.round(Number(nv)))); } })
              );
            }
            return E(View, { style: rowStyle }, E(Text, { style: titleStyle }, `Volume: ${slider}/90`), E(TextInput, { value: String(slider), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center", color: "#fff" }, onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) store.gain = Math.max(0, Math.min(90, Math.round(n))); } }));
          };
          return E(Container, { style: { flex: 1, paddingTop: 8 } },
            E(View, { style: { padding: 16, backgroundColor: "#222", borderRadius: 8, margin: 16 } }, E(Text, { style: { color: "#aaa", fontSize: 13 } }, "Volume 0-90: clean = loud & clear, raw = loud & distorted. Both up to 90.")),
            mkSwitch("Boost enabled", "enabled"),
            mkSwitch("Clear audio, no distortion", "clear"),
            mkSwitch("Raw mode (kill AGC / noise suppression)", "raw"),
            mkSwitch("Stereo + max bitrate", "stereo"),
            mkGain()
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
      logger.info("Input Boost starting (hot mic, target loud & raw)");
      try {
        hookTransport();
      } catch (e) {
        logger.info("transport hook failed: " + e);
      }
      try {
        hookVolumeSetters();
      } catch (e) {
        logger.info("volume hook failed: " + e);
      }
      try {
        hookFlux();
      } catch (e) {
        logger.info("flux hook failed: " + e);
      }
      try {
        hookSetConnection();
      } catch (e) {
        logger.info("connection hook failed: " + e);
      }
      try {
        patchMicSettings();
      } catch (e) {
        logger.info("mic settings patch failed: " + e);
      }
    },
    onUnload() {
      for (const undo of patches) {
        try {
          undo();
        } catch (e) {}
      }
      patches = [];
      if (voiceRetry) { try { clearInterval(voiceRetry); } catch {} voiceRetry = null; }
      if (fluxUnsub) {
        try {
          fluxUnsub();
        } catch (e) {}
        fluxUnsub = null;
      }
      for (const restore of saveOrig) {
        try {
          restore();
        } catch (e) {}
      }
      saveOrig.length = 0;
      logger.info("Input Boost stopped");
    },
    settings: buildSettings(),
  };
})()