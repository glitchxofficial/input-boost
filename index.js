(() => {
  const { metro, patcher, commands, plugin, ui, storage } = vendetta;
  const L = plugin?.logger ?? console;
  const st = plugin?.storage ?? {};
  st.enabled ??= true;
  st.forceMute ??= true;

  const common = metro?.common;
  const React = common?.React;
  const channels = common?.channels;

  const getVC = () => {
    try {
      const id = channels?.getVoiceChannelId?.();
      if (typeof id === "string") return id;
    } catch {}
    return null;
  };

  const findSocketModule = () => {
    for (const p of ["getSocket"]) {
      try {
        const mod = metro?.findByProps?.(p);
        if (mod?.getSocket) return mod;
      } catch {}
    }
    try {
      const alt = metro?.findByProps?.("getGateway");
      if (alt?.getGateway?.()?.socket) return alt;
    } catch {}
    return null;
  };
  const socketMod = findSocketModule();

  const getSocket = () => {
    try { return socketMod?.getSocket?.(); } catch { return null; }
  };

  const buildPayload = (channelId) => {
    let guildId = null;
    try {
      const ch = channels?.getChannel?.(channelId);
      if (ch?.guild_id) guildId = ch.guild_id;
    } catch {}
    return {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: !!st.forceMute,
      self_deaf: true,
      self_video: false,
      flags: 0,
    };
  };

  const sendNow = (enabled) => {
    const sock = getSocket();
    if (!sock || typeof sock.send !== "function") return false;
    const channelId = getVC();
    if (!channelId) return false;
    const data = buildPayload(channelId);
    if (enabled === false) {
      data.self_mute = false;
      data.self_deaf = false;
    } else if (st.enabled !== true) {
      data.self_deaf = false;
      if (!st.forceMute) data.self_mute = false;
    }
    try { sock.send(4, data); return true; } catch { return false; }
  };

  const applyNow = () => {
    const ok = sendNow(st.enabled);
    ui?.toasts?.showToast?.(ok ? "Fake state sent." : "Not in a voice channel.");
    return ok;
  };

  const unpatchers = [];
  const patchedSockets = new Set();
  let timer = null;

  const patchSocket = () => {
    const sock = getSocket();
    if (!sock || typeof sock.send !== "function" || patchedSockets.has(sock)) return;
    patchedSockets.add(sock);
    try {
      const unpatch = patcher.before("FakeDeafen-send", sock, (args) => {
        try {
          if (!Array.isArray(args) || args[0] !== 4) return;
          const data = args[1];
          if (!data) return;
          if (st.enabled) {
            data.self_mute = data.self_mute === void 0 ? !!st.forceMute : !!st.forceMute;
            data.self_deaf = true;
          }
        } catch {}
      });
      unpatchers.push(unpatch);
    } catch (e) { L?.log?.("patch failed", e); }
  };

  const ensureTicker = () => {
    if (timer) return;
    timer = setInterval(() => {
      try { patchSocket(); } catch {}
    }, 5000);
  };

  const toggle = () => {
    st.enabled = !st.enabled;
    const ok = sendNow(st.enabled);
    ui?.toasts?.showToast?.(`${st.enabled ? "Enabled" : "Disabled"} fake deafen${ok ? "" : " (no voice connection)"}.`);
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
            "Force self_deaf in voice state updates.",
            p.enabled,
            (v) => { p.enabled = v; applyNow(); },
            true),
        row("Also force mute",
            "Force self_mute alongside deafen.",
            p.forceMute,
            (v) => { p.forceMute = v; applyNow(); },
            false),
      );
    } catch { return null; }
  };

  const pluginObj = {
    onLoad: () => {
      L?.log?.("loaded");
      try { commands?.registerCommand?.(command); } catch (e) { L?.log?.("registerCommand failed", e); }
      ensureTicker();
      try { patchSocket(); } catch {}
      if (st.enabled) setTimeout(() => { try { applyNow(); } catch {} }, 1500);
    },
    onUnload: () => {
      try { if (timer) { clearInterval(timer); timer = null; } } catch {}
      try { unpatchers.forEach((u) => { try { u(); } catch {} }); } catch {}
      try { sendNow(false); } catch {}
      try { commands?.unregisterCommand?.("fd"); } catch {}
    },
  };

  if (Settings) pluginObj.settings = Settings;
  return { default: pluginObj };
})()