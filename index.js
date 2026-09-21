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
  const voiceManager = find("toggleSelfMute", ["toggleSelfMute", "toggleSelfDeafen"]);

  const getSocket = () => {
    try { return socketMod?.getSocket?.(); } catch { return null; }
  };

  const getVC = () => {
    try { return common?.channels?.getVoiceChannelId?.() ?? null; } catch { return null; }
  };

  let lastVoiceState = null;

  const remember = (state) => {
    if (state && typeof state === "object") {
      try { lastVoiceState = { ...state }; } catch {}
    }
  };

  const unpatchers = [];
  const patchedSockets = new Set();
  let timer = null;

  const forceState = (state) => {
    if (!state) return;
    if (st.enabled) {
      if (st.forceMute) {
        state.self_mute = true;
        state.selfMute = true;
      }
      if (st.forceDeafen) {
        state.self_deaf = true;
        state.selfDeaf = true;
      }
    }
  };

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
            if (st.enabled) forceState(state);
          } catch {}
        });
        unpatchers.push(up);
      }
    } catch (e) { L?.log?.("voiceStateUpdate patch failed", e); }
    try {
      if (typeof sock.send === "function") {
        const up2 = patcher.before("FakeDeafen-send", sock, (args) => {
          try {
            if (!Array.isArray(args) || args[0] !== 4) return;
            const data = args[1];
            if (!data) return;
            remember(data);
            if (st.enabled) forceState(data);
          } catch {}
        });
        unpatchers.push(up2);
      }
    } catch (e) { L?.log?.("send patch failed", e); }
  };

  const ensureTicker = () => {
    if (timer) return;
    timer = setInterval(() => { try { patchSocket(); } catch {} }, 5000);
  };

  // Double-toggle the real mute so Discord itself emits a voice state update,
  // while the patch fakes the outbound values. Local state nets out unchanged.
  const syncVoice = () => {
    const vc = getVC();
    if (!vc) return false;
    if (!voiceManager) return false;
    const toggle = typeof voiceManager.toggleSelfMute === "function"
      ? voiceManager.toggleSelfMute.bind(voiceManager)
      : typeof voiceManager.toggleSelfDeafen === "function"
        ? voiceManager.toggleSelfDeafen.bind(voiceManager)
        : null;
    if (!toggle) return false;
    try {
      toggle();
      setTimeout(() => { try { toggle(); } catch {} }, 80);
      return true;
    } catch { return false; }
  };

  // Re-send Discord's own last real state through its own path (unpatched / real values).
  const resendReal = () => {
    const sock = getSocket();
    if (!sock || !lastVoiceState || lastVoiceState.channelId == null) return false;
    try {
      if (typeof sock.voiceStateUpdate === "function") {
        sock.voiceStateUpdate({ ...lastVoiceState });
      } else if (typeof sock.send === "function") {
        sock.send(4, {
          guild_id: lastVoiceState.guildId ?? lastVoiceState.guild_id ?? null,
          channel_id: lastVoiceState.channelId,
          self_mute: !!lastVoiceState.selfMute,
          self_deaf: !!lastVoiceState.selfDeaf,
          self_video: false,
          flags: 0,
        });
      } else {
        return false;
      }
      return true;
    } catch { return false; }
  };

  const applyNow = () => {
    if (!getVC()) {
      ui?.toasts?.showToast?.("Not in a voice channel.");
      return false;
    }
    return syncVoice();
  };

  const toggle = () => {
    st.enabled = !st.enabled;
    const ok = st.enabled ? applyNow() : resendReal();
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
            (v) => { p.enabled = v; if (v) applyNow(); else resendReal(); },
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
      try { resendReal(); } catch {}
      try { commands?.unregisterCommand?.("fd"); } catch {}
    },
  };

  if (Settings) pluginObj.settings = Settings;
  return { default: pluginObj };
})()