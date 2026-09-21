(() => {
  const { metro, patcher, commands, plugin, ui, storage } = vendetta;
  const L = plugin?.logger ?? console;
  const st = plugin?.storage ?? {};
  st.enabled ??= true;
  st.forceMute ??= true;
  st.forceDeafen ??= true;

  const common = metro?.common;
  const React = common?.React;

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

  const getSocket = () => {
    try { return socketMod?.getSocket?.(); } catch { return null; }
  };

  let lastVoiceState = null;

  const remember = (state) => {
    if (state && typeof state === "object") {
      try { lastVoiceState = { ...state }; } catch {}
    }
  };

  const forceState = (state) => {
    if (!state || !st.enabled) return;
    if (st.forceMute) {
      state.self_mute = true;
      state.selfMute = true;
    }
    if (st.forceDeafen) {
      state.self_deaf = true;
      state.selfDeaf = true;
    }
  };

  // Seed lastVoiceState from VoiceStateStore so toggling works even before any update.
  const seedState = () => {
    try {
      const me = find("getCurrentUser", ["getCurrentUser"])?.getCurrentUser?.();
      const vss = find("getVoiceStates", ["getVoiceStates"]);
      let states = null;
      if (vss) {
        try { states = vss.getVoiceStates?.(); } catch {}
        if (states && typeof states.keys === "function") {
          try { states = [...states.values()]; } catch {}
        }
      }
      if (me && Array.isArray(states)) {
        const mine = states.find((s) => s?.userId === me.id || s?.user_id === me.id);
        if (mine) {
          lastVoiceState = {
            channelId: mine.channelId ?? mine.channel_id ?? null,
            guildId: mine.guildId ?? mine.guild_id ?? null,
            selfMute: !!mine.selfMute,
            selfDeaf: !!mine.selfDeaf,
            selfVideo: !!mine.selfVideo,
          };
          return;
        }
      }
      const vc = find("getVoiceChannelId", ["getVoiceChannelId"]);
      const channelId = vc?.getVoiceChannelId?.();
      if (channelId) {
        let guildId = null;
        try {
          const ch = common?.channels?.getChannel?.(channelId);
          if (ch?.guild_id) guildId = ch.guild_id;
        } catch {}
        lastVoiceState = { channelId, guildId, selfMute: false, selfDeaf: false, selfVideo: false };
      }
    } catch {}
  };

  // Re-send Discord's own last real state through its own (patched) method.
  // This keeps guild_id/channel_id/payload shape always correct, so the
  // server never misreads it as a channel change / leave.
  const resendVoiceState = () => {
    const sock = getSocket();
    if (!sock) return false;
    if (!lastVoiceState || lastVoiceState.channelId == null) return false;
    if (typeof sock.voiceStateUpdate !== "function") return false;
    try {
      sock.voiceStateUpdate({ ...lastVoiceState });
      return true;
    } catch { return false; }
  };

  const applyNow = () => {
    seedState();
    const ok = resendVoiceState();
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
        const up = patcher.before("FakeDeafen-vsu", sock, (args) => {
          try {
            const state = args && args[0];
            remember(state);
            forceState(state);
          } catch {}
        });
        unpatchers.push(up);
      }
    } catch (e) { L?.log?.("patch failed", e); }
  };

  const ensureTicker = () => {
    if (timer) return;
    timer = setInterval(() => { try { patchSocket(); } catch {} }, 5000);
  };

  const toggle = () => {
    st.enabled = !st.enabled;
    const ok = st.enabled ? applyNow() : resendVoiceState();
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
            "Force self_deaf in outbound voice state updates.",
            p.enabled,
            (v) => { p.enabled = v; if (v) applyNow(); else resendVoiceState(); },
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
      st.enabled = false;
      try { resendVoiceState(); } catch {}
      try { commands?.unregisterCommand?.("fd"); } catch {}
    },
  };

  if (Settings) pluginObj.settings = Settings;
  return { default: pluginObj };
})()