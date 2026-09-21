(() => {
  const { metro, patcher, commands, plugin, ui, storage } = vendetta;
  const L = plugin?.logger ?? { log: (...a) => console.log(...a) };
  const st = plugin?.storage ?? {};
  st.enabled ??= true;
  st.forceMute ??= true;
  st.forceDeafen ??= true;
  st.fabX ??= 16;
  st.fabY ??= 140;

  const common = metro?.common;
  const React = common?.React;
  const RN = common?.ReactNative;

  const log = (...a) => { try { L.log?.("[FakeDeafen]", ...a); } catch {} };

  const find = (props, attempts) => {
    for (const p of attempts ?? [props]) {
      try {
        const m = metro?.findByProps?.(p);
        if (m) return m;
      } catch {}
    }
    return null;
  };

  const socketMod = find("getSocket", ["getSocket", "getGatewayConnection"]);

  let lastSock = null;

  const getSocket = () => {
    try {
      const s = socketMod?.getSocket?.();
      if (s !== lastSock) {
        lastSock = s;
        log(s ? "socket acquired" : "socket empty / module " + (socketMod ? "found" : "NOT found"));
      }
      return s;
    } catch (e) { log("getSocket error", e); return null; }
  };

  // Normalize whichever voice-state shape Discord gives us into real snake_case data.
  const toSnake = (o) => {
    if (!o || typeof o !== "object") return null;
    return {
      guild_id: o.guild_id ?? o.guildId ?? null,
      channel_id: o.channel_id ?? o.channelId ?? null,
      self_mute: !!o.self_mute ?? !!o.selfMute,
      self_deaf: !!o.self_deaf ?? !!o.selfDeaf,
      self_video: o.self_video ?? !!o.selfVideo,
      flags: o.flags ?? 0,
      self_stream: o.self_stream ?? o.selfStream ?? false,
      suppress: o.suppress ?? false,
    };
  };

  let lastData = null;

  const remember = (raw) => {
    if (!raw) return;
    const d = toSnake(raw);
    if (!d || d.channel_id == null) return;
    lastData = d;
  };

  const force = (d) => {
    if (!d) return d;
    if (st.enabled) {
      if (st.forceDeafen) d.self_deaf = true;
      if (st.forceMute) d.self_mute = true;
    }
    return d;
  };

  const resendNow = () => {
    const sock = getSocket();
    if (!sock) return false;
    if (!lastData || lastData.channel_id == null) {
      log("resendNow: no lastData / not in voice");
      return false;
    }
    const out = force({ ...lastData });
    try {
      if (typeof sock.voiceStateUpdate === "function") {
        sock.voiceStateUpdate(out);
        log("resendNow via voiceStateUpdate", JSON.stringify(out));
        return true;
      }
      if (typeof sock.send === "function") {
        sock.send(4, out);
        log("resendNow via send(4,...)", JSON.stringify(out));
        return true;
      }
      log("resendNow: socket has neither voiceStateUpdate nor send");
      return false;
    } catch (e) { log("resendNow error", e); return false; }
  };

  const seedFromStore = () => {
    try {
      const me = find("getCurrentUser", ["getCurrentUser"])?.getCurrentUser?.();
      if (!me) return;
      const vss = find("getVoiceStates", ["getVoiceStates", "getVoiceState"]);
      if (!vss) return;
      let states = null;
      try { states = vss.getVoiceStates?.(); } catch {}
      if (states && typeof states.keys === "function") {
        try { states = [...states.values()]; } catch {}
      }
      if (Array.isArray(states)) {
        const mine = states.find((s) => s?.userId === me.id || s?.user_id === me.id);
        if (mine && (mine.channelId || mine.channel_id)) {
          lastData = toSnake(mine);
          log("seeded from getVoiceStates", JSON.stringify(lastData));
        }
      }
    } catch (e) { log("seedFromStore error", e); }
  };

  const applyNow = () => {
    if (!lastData || lastData.channel_id == null) seedFromStore();
    const ok = resendNow();
    if (!ok) ui?.toasts?.showToast?.("Not in a voice channel.");
    return ok;
  };

  const unpatchers = [];
  const patchedSockets = new Set();
  let timer = null;

  const patchSocket = () => {
    const sock = getSocket();
    if (!sock || patchedSockets.has(sock)) return;
    patchedSockets.add(sock);
    try {
      if (typeof sock.voiceStateUpdate === "function") {
        const up = patcher.before("voiceStateUpdate", sock, (args) => {
          try {
            const raw = args && args[0];
            remember(raw);
            force(raw);
          } catch {}
        });
        unpatchers.push(up);
        log("patched voiceStateUpdate");
      } else {
        log("socket.voiceStateUpdate NOT present");
      }
    } catch (e) { log("patch voiceStateUpdate error", e); }
    try {
      if (typeof sock.send === "function") {
        const up2 = patcher.before("send", sock, (args) => {
          try {
            if (!Array.isArray(args) || args[0] !== 4) return;
            const data = args[1];
            if (!data) return;
            remember(data);
            force(data);
          } catch {}
        });
        unpatchers.push(up2);
        log("patched send");
      } else {
        log("socket.send NOT present");
      }
    } catch (e) { log("patch send error", e); }
  };

  const ensureTicker = () => {
    if (timer) return;
    timer = setInterval(() => { try { patchSocket(); } catch {} }, 5000);
    log("ticker started");
  };

  const toggle = () => {
    st.enabled = !st.enabled;
    const ok = st.enabled ? applyNow() : resendNow();
    log("toggle enabled=", st.enabled, "ok=", ok);
    ui?.toasts?.showToast?.(`${st.enabled ? "Enabled" : "Disabled"} fake deafen${ok ? "" : " (no voice connection)"}.`);
    fabEmit();
    return st.enabled;
  };

  const command = {
    name: "fd",
    displayName: "fake deafen",
    description: "Toggle fake deafen (appear deafened/muted while still hearing).",
    options: [],
    execute: () => ({ content: `Fake Deafen ${toggle() ? "enabled" : "disabled"}.` }),
  };

  const Settings = () => {
    try {
      if (!React) return null;
      const Forms = ui?.components?.Forms;
      const FSR = Forms?.FormSwitchRow;
      const Div = Forms?.FormDivider;
      if (!FSR) return null;
      const p = storage?.useProxy?.(st) ?? st;
      const row = (label, subLabel, value, onChange, last) =>
        React.createElement(React.Fragment, null,
          React.createElement(FSR, { label, subLabel, value, onValueChange: onChange }),
          last ? React.createElement(Div, null) : null,
        );
      return React.createElement(React.Fragment, null,
        row("Fake Deafen",
            "Force self_deaf in outbound voice state updates.",
            p.enabled,
            (v) => { p.enabled = v; if (v) applyNow(); else resendNow(); fabEmit(); },
            true),
        row("Also force mute",
            "Force self_mute alongside deafen.",
            p.forceMute,
            (v) => { p.forceMute = v; if (st.enabled) applyNow(); },
            false),
        row("Force deafen",
            "Toggle forcing self_deaf separately.",
            p.forceDeafen,
            (v) => { p.forceDeafen = v; if (st.enabled) applyNow(); },
            false),
      );
    } catch { return null; }
  };

  // ---- floating draggable button ----
  const fabListeners = new Set();
  const fabEmit = () => { for (const l of fabListeners) { try { l(); } catch {} } };
  let fabUnpatch = null;
  let fabElement = null;

  const FloatingFab = () => {
    if (!React || !RN) return null;
    const { View, Text, Animated, PanResponder, Dimensions } = RN;
    const [enabled, setEnabled] = React.useState(!!st.enabled);
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const h = () => { setEnabled(!!st.enabled); bump((x) => x + 1); };
      fabListeners.add(h);
      return () => { fabListeners.delete(h); };
    }, []);

    const pan = React.useRef(new Animated.ValueXY({
      x: Number(st.fabX) || 16,
      y: Number(st.fabY) || 140,
    })).current;
    const pulse = React.useRef(new Animated.Value(0)).current;
    const dragRef = React.useRef({ moved: false });

    React.useEffect(() => {
      if (!enabled) return;
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]));
      loop.start();
      return () => { loop.stop(); pulse.setValue(0); };
    }, [enabled, pulse]);

    const resp = React.useRef(PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 3,
      onPanResponderGrant: () => { dragRef.current.moved = false; pulse.stopAnimation(); },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        listener: (_e, g) => { if (Math.abs(g.dx) + Math.abs(g.dy) > 8) dragRef.current.moved = true; },
        useNativeDriver: false,
      }),
      onPanResponderRelease: (_e, g) => {
        if (!dragRef.current.moved) { toggle(); return; }
        try {
          const dims = Dimensions.get("window");
          const x = Math.max(0, Math.min(dims.width - 64, (Number(st.fabX) || 16) + g.dx));
          const y = Math.max(0, Math.min(dims.height - 64, (Number(st.fabY) || 140) + g.dy));
          st.fabX = x;
          st.fabY = y;
          pan.setValue({ x, y });
        } catch {}
      },
      onPanResponderTerminate: () => {},
    })).current;

    const bg = enabled ? "#ED4245" : "#5865F2";
    const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

    return React.createElement(View, {
      style: {
        position: "absolute", left: 0, top: 0, right: 0, bottom: 0,
        zIndex: 999, elevation: 30, pointerEvents: "box-none",
      },
    }, React.createElement(Animated.View, {
      ...resp.panHandlers,
      style: [
        {
          position: "absolute", left: 0, top: 0,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: bg,
          alignItems: "center", justifyContent: "center",
          elevation: 20, shadowColor: "#000", shadowOpacity: 0.35,
          shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
        },
        { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale }] },
      ],
    },
      React.createElement(Text, { style: { color: "#ffffff", fontWeight: "800", fontSize: 16 } }, "FD"),
      React.createElement(Text, { style: { color: "#ffffff", fontSize: 8, opacity: 0.9 } }, enabled ? "ON" : "OFF"),
    ));
  };

  const overlayWrap = (res) => {
    try {
      if (res == null || typeof res !== "object") return res;
      if (!fabElement) fabElement = React.createElement(FloatingFab);
      if (Array.isArray(res)) return React.createElement(React.Fragment, null, ...res, fabElement);
      return React.createElement(React.Fragment, null, res, fabElement);
    } catch { return res; }
  };

  const mountFab = () => {
    if (!React || !RN) { log("FAB: no React/ReactNative"); return; }
    try {
      const comp = metro?.findByName?.("App");
      if (comp?.prototype && typeof comp.prototype.render === "function") {
        fabUnpatch = patcher.after("render", comp.prototype, (args, ret) => overlayWrap(ret));
        log("FAB mounted on App");
        return;
      }
      log("FAB: App not patchable");
    } catch (e) { log("FAB App patch error", e); }
    try {
      const comp = metro?.findByName?.("Chat");
      if (comp?.prototype && typeof comp.prototype.render === "function") {
        fabUnpatch = patcher.after("render", comp.prototype, (args, ret) => overlayWrap(ret));
        log("FAB mounted on Chat");
        return;
      }
      log("FAB: Chat not patchable");
    } catch (e) { log("FAB Chat patch error", e); }
  };

  let unregCommand = null;

  const pluginObj = {
    onLoad: () => {
      log("loaded");
      try { unregCommand = commands?.registerCommand?.(command); } catch (e) { log("registerCommand failed", e); }
      ensureTicker();
      try { patchSocket(); } catch (e) { log("onLoad patch error", e); }
      try { mountFab(); } catch (e) { log("mountFab error", e); }
      if (st.enabled) setTimeout(() => { try { applyNow(); } catch (e) { log("auto apply error", e); } }, 1500);
    },
    onUnload: () => {
      try { if (timer) { clearInterval(timer); timer = null; } } catch {}
      try { unpatchers.forEach((u) => { try { u(); } catch {} }); } catch {}
      try { if (fabUnpatch) { fabUnpatch(); fabUnpatch = null; } } catch {}
      try { fabListeners.clear(); } catch {}
      st.enabled = false;
      try { resendNow(); } catch {}
      try { if (unregCommand) unregCommand(); else commands?.unregisterCommand?.("fd"); } catch {}
    },
  };

  if (Settings) pluginObj.settings = Settings;
  return { default: pluginObj };
})()