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

  const buildSettings = () => {
    const c = ui.components ?? {};
    const { Form, FormRow, FormSection, FormText, FormSwitchRow, FormInput } = c;
    if (!React) return () => null;
    const E = React.createElement;

    if (!FormOrRow(Form, FormRow)) {
      return () =>
        E(TextEl(ui), { style: {} }, "Full Settings UI unavailable");
    }

    const Section = FormSection || ((props) => E(props.children));
    const T = FormText || FormRow;
    const Row = FormRow;
    const Switch = FormSwitchRow || FormRow;

    return () => {
      const rows = [];
      rows.push(
        E(
          Section,
          { title: "Input Boost" },
          [E(T, { variant: "text-md/semibold", style: { paddingHorizontal: 16, paddingTop: 8 } },
            "Yells at Discord's voice engine so your mic transmits hotter. Listeners still control their own volume.")]
        )
      );

      const mkSwitch = (title, key) =>
        E(Switch, {
          label: title,
          value: !!store[key],
          onValueChange: (v) => {
            store[key] = !!v;
          },
        });

      const mkInput = (title, key, kind) =>
        E(Row, {
          label: title,
          trailing: E(FormInput, {
            value: String(store[key]),
            keyboardType: "number-pad",
            onChangeText: (t) => {
              store[key] = kind === "num" ? Number(t) : t;
            },
          }),
        });

      rows.push(mkSwitch("Boost enabled", "enabled"));
      rows.push(mkSwitch("Clear audio, no distortion", "clear"));
      rows.push(mkSwitch("Raw mode (kill AGC / noise suppression)", "raw"));
      rows.push(mkSwitch("Stereo + max bitrate", "stereo"));
      rows.push(mkInput("Gain multiplier (max 1.5 in clear mode)", "gain", "num"));

      return E(Form, null, rows);
    };
  };

  const FormOrRow = (...els) => els.some((e) => !!e);
  const TextEl = (ui2) => ui2.components?.FormText || ui2.components?.FormRow || "Text";

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