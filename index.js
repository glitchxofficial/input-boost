(() => {
  const { metro, patcher, ui, plugin, logger } = vendetta;
  const { findByProps } = metro;
  const FluxDispatcher = metro.common?.FluxDispatcher;
  const React = metro.common?.React;

  const store = plugin?.storage ?? {};
  if (store.gain == null) store.gain = 4;
  if (store.bitrate == null) store.bitrate = 512000;
  if (store.raw == null) store.raw = true;
  if (store.stereo == null) store.stereo = true;
  if (store.enabled == null) store.enabled = true;
  if (store.clear == null) store.clear = false;

  const cfg = () => {
    const g = Number(store.gain);
    const base = Number.isFinite(g) ? Math.max(1, Math.min(10, g)) : 4;
    const clear = store.clear === true;
    return {
      enabled: store.enabled !== false,
      clear,
      gain: clear ? Math.min(base, 1.5) : base,
      bitrate: store.bitrate === 384000 ? 384000 : 512000,
      raw: clear ? false : store.raw !== false,
      stereo: store.stereo !== false,
    };
  };

  let patches = [];
  let fluxUnsub = null;
  const saveOrig = [];

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
          const mkGain = () => {
            if (!InputComp || InputComp === RN?.TextInput) {
              return E(Row, { label: "Gain (max 1.5 clear / 10 raw)", trailing: E(RN.TextInput, { value: String(store.gain), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center" }, onChangeText: (t) => { const n = Number(t); store.gain = Number.isFinite(n) ? n : store.gain; } }) });
            }
            return E(Row, { label: "Gain (max 1.5 clear / 10 raw)", trailing: E(InputComp, { value: String(store.gain), keyboardType: "number-pad", onChangeText: (t) => { const n = Number(t); store.gain = Number.isFinite(n) ? n : store.gain; } }) });
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
          const mkGain = () => E(View, { style: rowStyle }, E(Text, { style: titleStyle }, "Gain (1-10, 1.5 max in clear)"), E(TextInput, { value: String(store.gain), keyboardType: "number-pad", style: { borderWidth: 1, borderColor: "#555", borderRadius: 6, padding: 6, minWidth: 60, textAlign: "center", color: "#fff" }, onChangeText: (t) => { const n = Number(t); if (Number.isFinite(n)) store.gain = n; } }));
          return E(Container, { style: { flex: 1, paddingTop: 8 } },
            E(View, { style: { padding: 16, backgroundColor: "#222", borderRadius: 8, margin: 16 } }, E(Text, { style: { color: "#aaa", fontSize: 13 } }, "Hot mic: Clear = loud & clean (1.5x), Raw = overdriven & distorted (up to 10x). Listeners control their own volume.")),
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
    },
    onUnload() {
      for (const undo of patches) {
        try {
          undo();
        } catch (e) {}
      }
      patches = [];
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