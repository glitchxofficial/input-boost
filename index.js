(() => {
  const { metro, patcher, commands, plugin, ui, storage, utils } = vendetta;
  const L = plugin?.logger ?? { log: (...a) => console.log(...a) };
  const st = plugin?.storage ?? {};
  st.enabled ??= true;
  st.forceMute ??= true;
  st.forceDeafen ??= true;
  st.graceMs ??= 1500;
  st.fabX ??= 16;
  st.fabY ??= 140;

  const common = metro?.common;
  const React = common?.React;
  const RN = common?.ReactNative;

  // ---- diagnostics (visible in Settings) ----
  const dbgState = { socket: "?", vsu: "?", send: "?", fab: "?", lastApply: "-" };
  const dbgLines = [];
  const log = (...a) => {
    try {
      const msg = a.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(" ");
      dbgLines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      if (dbgLines.length > 40) dbgLines.shift();
      L.log?.("[FakeDeafen]", ...a);
    } catch {}
  };

  const find = (props, attempts) => {
    for (const p of attempts ?? [props]) {
      try {
        const m = metro?.findByProps?.(p);
        if (m) return m;
      } catch {}
    }
    return null;
  };
  const findName = (n) => {
    try { return metro?.findByName?.(n); } catch (e) { return null; }
  };

  const socketMod = find("getSocket", ["getSocket", "getGatewayConnection"]);
  dbgState.socket = socketMod ? "module found" : "MODULE NOT FOUND";

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
  let prevChannelSet = null;
  let joinedAt = 0;
  let joinTimer = null;
  let autoArmed = false;

  const remember = (raw) => {
    const d = toSnake(raw);
    if (!d || d.channel_id == null) return null;
    const firstJoin = prevChannelSet !== d.channel_id;
    prevChannelSet = d.channel_id;
    lastData = d;
    if (firstJoin) {
      joinedAt = Date.now();
      log("remembered (join/move)", JSON.stringify(d));
      if (autoArmed) { scheduleAutoForce(); }
    } else {
      log("remembered", JSON.stringify(d));
    }
    return { firstJoin };
  };

  const force = (d, opts) => {
    if (st.enabled && d && d.channel_id != null) {
      let grace = Number(st.graceMs);
      if (typeof st.graceMs !== "number" || Number.isNaN(grace)) grace = 1500;
      const bypass = !!(opts && opts.override);
      if (bypass || Date.now() - joinedAt >= grace) {
        if (st.forceDeafen) d.self_deaf = true;
        if (st.forceMute) d.self_mute = true;
      }
    }
    return d;
  };

  const scheduleAutoForce = () => {
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
    joinTimer = setTimeout(() => {
      joinTimer = null;
      if (!st.enabled || !lastData || lastData.channel_id == null) return;
      const ok = resendNow();
      dbgState.lastApply = "auto-after-join " + (ok ? "sent" : "no-connection");
      log("auto re-apply after join ok=", ok);
    }, 900);
  };

  const resendNow = () => {
    const sock = getSocket();
    if (!sock) return false;
    if (!lastData || lastData.channel_id == null) {
      log("resendNow: no lastData / not in voice");
      return false;
    }
    const out = force({ ...lastData }, { override: true });
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
          prevChannelSet = lastData.channel_id;
          log("seeded from getVoiceStates", JSON.stringify(lastData));
        }
      }
    } catch (e) { log("seedFromStore error", e); }
  };

  const applyNow = () => {
    if (!lastData || lastData.channel_id == null) seedFromStore();
    const ok = resendNow();
    dbgState.lastApply = "manual " + (ok ? "sent" : "no-connection");
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
            const r = remember(raw);
            dbgState.vsu = "patched";
            force(raw, r);
          } catch {}
        });
        unpatchers.push(up);
        dbgState.vsu = "patched";
        log("patched voiceStateUpdate");
      } else {
        dbgState.vsu = "absent";
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
            const r = remember(data);
            dbgState.send = "patched";
            force(data, r);
          } catch {}
        });
        unpatchers.push(up2);
        dbgState.send = "patched";
        log("patched send");
      } else {
        dbgState.send = "absent";
        log("socket.send NOT present");
      }
    } catch (e) { log("patch send error", e); }
  };

  const ensureTicker = () => {
    if (timer) return;
    timer = setInterval(() => { try { patchSocket(); } catch {} }, 5000);
    log("ticker started");
  };

  // ---- floating button ----
  const fabListeners = new Set();
  const fabEmit = () => { for (const l of fabListeners) { try { l(); } catch {} } };
  let fabUnpatch = null;
  let fabElement = null;
  let injectedFab = false;
  let ceOrig = null;

  const FloatingFab = () => {
    try {
      if (!React || !RN) return null;
      const { View, Text, Animated, PanResponder, Dimensions } = RN;
      const [enabled, setEnabled] = React.useState(!!st.enabled);
      React.useEffect(() => {
        const h = () => setEnabled(!!st.enabled);
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
          Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
          Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: false }),
        ]));
        loop.start();
        return () => { try { loop.stop(); } catch {} };
      }, [enabled, pulse]);

      const startX = React.useRef(pan.x._v ?? pan._x ?? 16);
      const startY = React.useRef(pan.y._v ?? pan._y ?? 140);

      const resp = React.useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
        onPanResponderGrant: (_e, g) => {
          dragRef.current.moved = false;
          startX.current = pan.x._v ?? (startX.current + g.dx);
          startY.current = pan.y._v ?? (startY.current + g.dy);
          try { pulse.stopAnimation(); } catch {}
        },
        onPanResponderMove: (_e, g) => {
          if (Math.abs(g.dx) + Math.abs(g.dy) > 10) dragRef.current.moved = true;
          try { pan.setValue({ x: startX.current + g.dx, y: startY.current + g.dy }); } catch {}
        },
        onPanResponderRelease: (_e, g) => {
          if (!dragRef.current.moved) { toggle(); return; }
          try {
            const dims = Dimensions.get("window");
            const x = Math.max(0, Math.min(dims.width - 56, startX.current + g.dx));
            const y = Math.max(0, Math.min(dims.height - 56, startY.current + g.dy));
            st.fabX = x;
            st.fabY = y;
            pan.setValue({ x, y });
          } catch {}
        },
        onPanResponderTerminate: () => {},
      })).current;

      const bg = enabled ? "#ED4245" : "#5865F2";
      const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });

      return React.createElement(View, {
        style: {
          position: "absolute", left: 0, top: 0, right: 0, bottom: 0,
          zIndex: 999, pointerEvents: "box-none",
        },
      }, React.createElement(Animated.View, {
        ...resp.panHandlers,
        style: [
          {
            position: "absolute", left: 0, top: 0,
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: bg,
            alignItems: "center", justifyContent: "center",
            elevation: 30, shadowColor: "#000", shadowOpacity: 0.4,
            shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
          },
          { transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale }] },
        ],
      },
        React.createElement(Text, { style: { color: "#ffffff", fontWeight: "800", fontSize: 16 } }, "FD"),
        React.createElement(Text, { style: { color: "#ffffff", fontSize: 8, opacity: 0.9 } }, enabled ? "ON" : "OFF"),
      ));
    } catch { return null; }
  };

  const getFabEl = () => {
    if (!fabElement) fabElement = React.createElement(FloatingFab);
    return fabElement;
  };

  const overlayWrap = (res) => {
    try {
      if (res == null || typeof res !== "object") return res;
      if (!React || !RN) return res;
      const el = getFabEl();
      // identity-safe: mutate the element's own props so Discord keeps the same element
      if (typeof res.props === "object" && res.props !== null) {
        const old = res.props.children;
        if (Array.isArray(old)) {
          if (!old.includes(el)) res.props.children = old.concat(el);
        } else {
          res.props.children = old == null ? [el] : [old, el];
        }
        return res;
      }
      return React.createElement(React.Fragment, null, res, el);
    } catch { return res; }
  };

  const mountViaClass = (name) => {
    try {
      const comp = findName(name);
      if (comp?.prototype && typeof comp.prototype.render === "function") {
        fabUnpatch = patcher.after("render", comp.prototype, (_args, ret) => overlayWrap(ret));
        dbgState.fab = "mounted on " + name;
        log("FAB mounted on " + name);
        return true;
      }
    } catch (e) { log("FAB " + name + " patch error", e); }
    return false;
  };

  // Function-component safe fallback: find the app root type (even if the app is
  // already running) and inject the FAB by element-type identity via createElement.
  const mountViaRoot = () => {
    try {
      const AR = find("registerComponent", ["registerComponent", "AppRegistry"]);
      if (!AR || !React) return false;
      const Mod = (typeof utils?.unfreeze === "function" ? utils.unfreeze(AR) : AR) ?? AR;
      let rootType = null;
      const tryKey = (k) => { try { const p = AR.getComponentProvider?.(k); if (typeof p === "function") rootType = p(); } catch {} };
      try {
        if (typeof AR.getComponentProvider === "function") {
          tryKey("App");
          if (!rootType && typeof AR.getAppKeys === "function") {
            for (const k of AR.getAppKeys() || []) { tryKey(k); if (rootType) break; }
          }
        }
      } catch {}
      const origReg = Mod.registerComponent;
      let regHook = false;
      if (typeof origReg === "function") {
        Mod.registerComponent = function (key, provider) {
          try { if (!rootType && typeof provider === "function") rootType = provider(); } catch {}
          return origReg.apply(this, arguments);
        };
        regHook = true;
      }
      const rootLabel = typeof rootType === "function" ? (rootType.displayName || rootType.name || "fn") : rootType ? String(rootType) : "";
      if (!rootType) {
        if (regHook) {
          fabUnpatch = () => { try { Mod.registerComponent = origReg; } catch {} };
          dbgState.fab = "root pending (appears on next reload)";
          log("FAB root: will capture on next register");
          return true;
        }
        return false;
      }
      ceOrig = React.createElement;
      React.createElement = function (type, props) {
        const el = ceOrig.apply(this, arguments);
        if (!injectedFab && type === rootType) {
          injectedFab = true;
          if (!fabElement) fabElement = React.createElement(FloatingFab);
          return React.createElement(React.Fragment, null, el, fabElement);
        }
        return el;
      };
      fabUnpatch = () => {
        try { if (ceOrig) React.createElement = ceOrig; } catch {}
        injectedFab = false;
      };
      dbgState.fab = "root interception (" + rootLabel + ")";
      log("FAB root interception installed (" + rootLabel + ")");
      return true;
    } catch (e) { log("FAB root error", e); return false; }
  };

  const mountFab = () => {
    if (!React || !RN) { log("FAB: no React/ReactNative"); dbgState.fab = "no React/ReactNative"; return; }
    if (mountViaClass("App")) return;
    if (mountViaClass("Chat")) return;
    if (mountViaClass("Navigator")) return;
    if (mountViaClass("Home")) return;
    if (mountViaClass("VoicePanel")) return;
    if (mountViaClass("ChannelList")) return;
    if (!mountViaRoot()) dbgState.fab = "NO MOUNT FOUND";
  };

  // ---- toggle / command ----
  const toggle = () => {
    st.enabled = !st.enabled;
    const ok = st.enabled ? applyNow() : resendNow();
    log("toggle enabled=", st.enabled, "ok=", ok);
    ui?.toasts?.showToast?.(`${st.enabled ? "Enabled" : "Disabled"} BY Fiona${ok ? "" : " (no voice connection)"}.`);
    fabEmit();
    return st.enabled;
  };

  let unregCommand = null;
  let registered = null;
  const command = {
    name: "fd",
    displayName: "fake deafen",
    description: "Toggle BY Fiona (appear deafened/muted while still hearing).",
    options: [],
    execute: () => {
      const on = toggle();
      return { content: `BY Fiona ${on ? "enabled" : "disabled"}.` };
    },
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
      const diagText = RN?.Text ? RN.Text : null;
      const diag = diagText
        ? React.createElement(React.Fragment, null,
            React.createElement(Div, null),
            React.createElement(diagText, { variant: "text-xs/normal", selectable: true,
              style: { fontFamily: "monospace", padding: 8, color: "#a0a0a0" } },
              "Status: " + JSON.stringify(dbgState) + "\n\n" + (dbgLines.join("\n") || "no logs yet")),
          )
        : null;
      return React.createElement(React.Fragment, null,
        row("BY Fiona",
            "Force self_deaf in outbound voice state updates.",
            p.enabled,
            (v) => { p.enabled = v; if (v) applyNow(); else resendNow(); fabEmit(); },
            false),
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
        row("Join grace period (ms)",
            "Do not spoof within this window after joining a channel (prevents disconnects).",
            p.graceMs,
            (v) => { p.graceMs = Number(v) || 0; },
            false),
        diag ?? React.createElement(React.Fragment, null),
      );
    } catch { return null; }
  };

  autoArmed = true;

  const pluginObj = {
    onLoad: () => {
      log("loaded");
      try { unregCommand = commands?.registerCommand?.(command); registered = command; } catch (e) { log("registerCommand failed", e); }
      ensureTicker();
      try { patchSocket(); } catch (e) { log("onLoad patch error", e); }
      try { mountFab(); } catch (e) { log("mountFab error", e); }
      try { seedFromStore(); } catch (e) { log("seed error", e); }
    },
    onUnload: () => {
      try { if (timer) { clearInterval(timer); timer = null; } } catch {}
      try { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } } catch {}
      try { unpatchers.forEach((u) => { try { u(); } catch {} }); } catch {}
      try { if (fabUnpatch) { fabUnpatch(); fabUnpatch = null; } } catch {}
      try { fabListeners.clear(); } catch {}
      st.enabled = false;
      try { resendNow(); } catch {}
      try { if (unregCommand) unregCommand(); } catch {}
    },
  };

  if (Settings) pluginObj.settings = Settings;
  return { default: pluginObj };
})()