/* timer.js — Combat Timer (styles selector: exit removed, actions moved under description)
   MODULE_ID: "combat-timer"
*/

const MODULE_ID = "combat-timer";

/* --------------------------
   Small helpers S
   -------------------------- */
const S = {
  get(key) { return game.settings.get(MODULE_ID, key); },
  isNPC(combatant) { return !!(combatant?.actor?.type && String(combatant.actor.type).toLowerCase() === "npc"); },
  sec(v, fallback = 0) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
};

/* --------------------------
   Style loader / manager
   -------------------------- */
const Styles = {
  _linkId: "ct-style",
  _manifestPath() { return `modules/${MODULE_ID}/styles/styles.json`; },
  _stylesDir() { return `modules/${MODULE_ID}/styles/`; },

  async loadAvailableStyles() {
    try {
      const res = await fetch(this._manifestPath(), { cache: "no-store" });
      if (!res.ok) throw new Error("no manifest");
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data.map(d => ({
        id: d.id || d.file,
        name: d.name || d.file,
        file: d.file,
        preview: d.preview || null,
        description: d.description || ""
      }));
      throw new Error("invalid manifest");
    } catch (err) {
      return [{ id: "default", name: "Default", file: "default.css", preview: null, description: "Fallback default style (drop styles/styles.json to register more)" }];
    }
  },

  async loadStyle(file, save = true) {
    if (!file) return this.unloadStyle(save);
    const href = `${this._stylesDir()}${file}`;
    const prev = document.getElementById(this._linkId);
    if (prev) prev.remove();
    const link = document.createElement("link");
    link.id = this._linkId;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = href;
    link.onload = () => console.log(`[${MODULE_ID}] style loaded: ${file}`);
    link.onerror = () => console.warn(`[${MODULE_ID}] failed to load style: ${file} (${href})`);
    document.head.appendChild(link);
    if (save) {
      try { await game.settings.set(MODULE_ID, "hudStyle", file); } catch (e) {}
    }
  },

  unloadStyle(save = true) {
    const prev = document.getElementById(this._linkId);
    if (prev) prev.remove();
    if (save) {
      try { game.settings.set(MODULE_ID, "hudStyle", ""); } catch (e) {}
    }
  },

  async applyCurrent() {
    const force = game.settings.get(MODULE_ID, "forceStyleByGM");
    const gmFile = game.settings.get(MODULE_ID, "gmHudStyle") || "";
    if (force && gmFile) {
      await this.loadStyle(gmFile, false);
      return;
    }
    const current = game.settings.get(MODULE_ID, "hudStyle") || "";
    if (current) await this.loadStyle(current, false);
    else this.unloadStyle(false);
  }
};

/* --------------------------
   HUD
   -------------------------- */
class CombatTimerHUD {
  constructor() {
    this.minimized = false;
    this._currentTokenSrc = "";
    this._built = false;
    this._createInlineAnimStyles();
    this._build();
  }

  _createInlineAnimStyles() {
    if (document.getElementById("ct-inline-anim")) return;
    const style = document.createElement("style");
    style.id = "ct-inline-anim";
    style.textContent = `
      #combat-timer-hud { transition: opacity 260ms ease; }
    `;
    document.head.appendChild(style);
  }

  _build() {
    if (this._built) return;
    const isGM = game.user.isGM;

    const root = document.createElement("div");
    root.id = "combat-timer-hud";
    root.style.visibility = "hidden";
    root.style.opacity = "0";
    root.style.display = "block";

    root.innerHTML = `
      <div class="ct-header" style="position:relative;">
        <i class="fas fa-hourglass-half"></i>
        <div class="ct-title">Turn Timer</div>
      </div>
      <div class="ct-body">
        <img class="ct-token" src="" alt="token">
        <div class="ct-name">—</div>
        <div class="ct-time">0</div>
        <div class="ct-bar"><div class="ct-fill"></div></div>
        <div class="ct-foot"></div>
      </div>
    `;
    document.body.appendChild(root);

    this.root = root;
    this.headerEl = root.querySelector(".ct-header");
    this.footEl = root.querySelector(".ct-foot");
    this.nameEl = root.querySelector(".ct-name");
    this.timeEl = root.querySelector(".ct-time");
    this.fillEl = root.querySelector(".ct-fill");
    this.tokenEl = root.querySelector(".ct-token");

    this.tokenEl.style.display = "none";

    this._loadPersisted();
    this._createMinimizeButton();
    if (isGM) this._createGMControls();
    this._enableDrag();

    this.applyScaleAndClamp();

    this._built = true;
  }

  _createMinimizeButton() {
    const small = document.createElement("div");
    small.className = "ct-minimize-small";
    small.style.position = "absolute";
    small.style.right = "6px";
    small.style.top = "6px";
    small.style.width = "22px";
    small.style.height = "22px";
    small.style.borderRadius = "6px";
    small.style.display = "flex";
    small.style.alignItems = "center";
    small.style.justifyContent = "center";
    small.style.cursor = "pointer";
    small.style.userSelect = "none";
    small.style.fontWeight = "700";
    small.style.background = "rgba(255,255,255,0.04)";
    small.style.color = "white";
    small.innerText = this.minimized ? "+" : "−";
    small.title = this.minimized ? "Maximize" : "Minimize";
    this.headerEl.appendChild(small);
    small.addEventListener("click", () => { this.toggleMinimize(); this._persist(); });
  }

  _createGMControls() {
    this.footEl.innerHTML = `
      <div class="ct-btn ct-reset" title="Reset">⟲</div>
      <div class="ct-btn ct-prev"  title="Previous">⏮</div>
      <div class="ct-btn ct-play"  title="Pause/Play">⏸</div>
      <div class="ct-btn ct-next"  title="Next">⏭</div>
    `;

    this.footEl.querySelector(".ct-reset")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const c = game.combats?.active;
      if (c?.started) CombatTimerEngine.reset(c);
    });

    this.footEl.querySelector(".ct-prev")?.addEventListener("click", async () => {
      if (!game.user.isGM) return;
      const c = game.combats?.active;
      if (!c?.started) return;
      if (typeof c.previousTurn === "function") {
        c.previousTurn().catch(e => console.error(`[${MODULE_ID}] previousTurn`, e));
      } else {
        const tcount = c.combatants?.size ?? 0;
        if (tcount > 0) {
          const newTurn = ((c.turn - 1) + tcount) % tcount;
          c.update({ turn: newTurn }).catch(e => console.error(`[${MODULE_ID}] manual previousTurn`, e));
        }
      }
    });

    this.footEl.querySelector(".ct-play")?.addEventListener("click", () => {
      if (!game.user.isGM) return;
      const c = game.combats?.active;
      if (c) CombatTimerEngine.togglePause(c, null);
    });

    this.footEl.querySelector(".ct-next")?.addEventListener("click", () => {
      if (!game.user.isGM) return;
      const c = game.combats?.active;
      if (c?.started) c.nextTurn().catch(e => console.error(`[${MODULE_ID}] nextTurn`, e));
    });
  }

  _loadPersisted() {
    try {
      const saved = game.settings.get(MODULE_ID, "hudPosition") || {};
      if (saved && typeof saved === "object") {
        if (saved.minimized) this.minimized = !!saved.minimized;
        if (Number.isFinite(saved.left)) this.root.style.left = `${saved.left}px`;
        if (Number.isFinite(saved.top)) this.root.style.top = `${saved.top}px`;
      }
    } catch (err) { console.warn(`[${MODULE_ID}] loadPersisted failed`, err); }
  }

  _persist() {
    try {
      const fixed = this.root.classList.contains("fixed");
      const computed = window.getComputedStyle(this.root);
      const left = parseFloat(computed.left);
      const top = parseFloat(computed.top);
      const payload = {
        minimized: !!this.minimized,
        left: !fixed && Number.isFinite(left) ? Math.round(left) : undefined,
        top:  !fixed && Number.isFinite(top)  ? Math.round(top)  : undefined
      };
      game.settings.set(MODULE_ID, "hudPosition", payload);
    } catch (err) { console.warn(`[${MODULE_ID}] persist failed`, err); }
  }

  _enableDrag() {
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    const onDown = (ev) => {
      if (!ev.target.closest(".ct-header")) return;
      if (this.root.classList.contains("fixed")) return;
      dragging = true;
      sx = ev.clientX; sy = ev.clientY;
      const comp = window.getComputedStyle(this.root);
      sl = parseFloat(comp.left) || this.root.getBoundingClientRect().left;
      st = parseFloat(comp.top) || this.root.getBoundingClientRect().top;
      document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      this.root.style.left = `${Math.round(sl + dx)}px`; this.root.style.top = `${Math.round(st + dy)}px`;
      this.root.style.right = "auto"; this.root.style.bottom = "auto"; this._clampToViewport();
    };
    const onUp = () => { dragging = false; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); this._persist(); };
    this.root.addEventListener("mousedown", onDown);
  }

  show() {
    if (!this.root) return;
    const comp = window.getComputedStyle(this.root);
    if (comp.visibility !== "hidden" && parseFloat(comp.opacity || "1") > 0.99) return;
    this.root.style.display = "block";
    this.root.style.visibility = "";
    this.root.style.opacity = "0";
    // force reflow
    // eslint-disable-next-line no-unused-expressions
    this.root.getBoundingClientRect();
    requestAnimationFrame(() => { this.root.style.opacity = "1"; });
  }

  hide() {
    if (!this.root) return;
    const el = this.root;
    const comp = window.getComputedStyle(el);
    if ((comp.visibility === "hidden" || parseFloat(comp.opacity || "1") < 0.01) && el.style.display === "none") return;
    const onTransitionEnd = (ev) => {
      if (ev && ev.propertyName && ev.propertyName !== "opacity") return;
      el.removeEventListener("transitionend", onTransitionEnd);
      try { el.style.display = "none"; el.style.visibility = "hidden"; } catch (e) {}
    };
    el.addEventListener("transitionend", onTransitionEnd);
    const fallback = setTimeout(() => {
      el.removeEventListener("transitionend", onTransitionEnd);
      try { el.style.display = "none"; el.style.visibility = "hidden"; } catch (e) {}
      clearTimeout(fallback);
    }, 380);
    requestAnimationFrame(() => { el.style.opacity = "0"; });
  }

  toggleMinimize() {
    this.minimized = !this.minimized;
    this.root.classList.toggle("minimized", this.minimized);
    const small = this.root.querySelector(".ct-minimize-small");
    if (small) { small.innerText = this.minimized ? "+" : "−"; small.title = this.minimized ? "Maximize" : "Minimize"; }
    this._persist(); this.applyScaleAndClamp();
  }

  applyFixedMode() {
    const isGM = game.user.isGM;
    const fixed = isGM ? S.get("fixedModeGM") : S.get("fixedModePlayers");
    const pos = S.get("fixedPosition");
    if (fixed) { this.root.classList.add("fixed"); this.root.dataset.fixedPos = pos; }
    else { this.root.classList.remove("fixed"); delete this.root.dataset.fixedPos; const saved = game.settings.get(MODULE_ID, "hudPosition") || {}; if (saved && Number.isFinite(saved.left)) this.root.style.left = `${saved.left}px`; if (saved && Number.isFinite(saved.top)) this.root.style.top = `${saved.top}px`; }
  }

  applyScaleAndClamp() {
    const scale = S.sec(S.get("hudScale"), 1.0);
    const fixedPos = this.root.dataset.fixedPos;
    let origin = "top left";
    if (fixedPos) origin = { "top-left":"top left", "top-right":"top right", "bottom-left":"bottom left", "bottom-right":"bottom right" }[fixedPos] || "top left";
    this.root.style.transformOrigin = origin;
    this.root.style.transform = `scale(${scale})`;

    requestAnimationFrame(() => {
      const margin = 8;
      const useGMOffsets = !!game.user.isGM;
      const hPercent = useGMOffsets ? Number(game.settings.get(MODULE_ID, "gmOffsetHPercent") || 0) : Number(game.settings.get(MODULE_ID, "playerOffsetHPercent") || 0);
      const vPercent = useGMOffsets ? Number(game.settings.get(MODULE_ID, "gmOffsetVPercent") || 0) : Number(game.settings.get(MODULE_ID, "playerOffsetVPercent") || 0);

      const offsetXpx = Math.round((hPercent / 100) * window.innerWidth);
      const offsetYpx = Math.round((vPercent / 100) * window.innerHeight);

      if (this.root.classList.contains("fixed") && this.root.dataset.fixedPos) {
        const pos = this.root.dataset.fixedPos;
        switch (pos) {
          case "top-left":
            this.root.style.left = `${margin + offsetXpx}px`;
            this.root.style.top  = `${margin + offsetYpx}px`;
            this.root.style.right = this.root.style.bottom = "auto";
            break;
          case "top-right":
            this.root.style.right = `${margin + offsetXpx}px`;
            this.root.style.top   = `${margin + offsetYpx}px`;
            this.root.style.left = this.root.style.bottom = "auto";
            break;
          case "bottom-left":
            this.root.style.left = `${margin + offsetXpx}px`;
            this.root.style.bottom = `${margin + offsetYpx}px`;
            this.root.style.top = this.root.style.right = "auto";
            break;
          default:
            this.root.style.right = `${margin + offsetXpx}px`;
            this.root.style.bottom = `${margin + offsetYpx}px`;
            this.root.style.left = this.root.style.top = "auto";
            break;
        }

        requestAnimationFrame(() => {
          const r2 = this.root.getBoundingClientRect();
          let adjustLeft = null, adjustTop = null, needAdjust = false;
          if (r2.left < margin) { needAdjust = true; adjustLeft = margin; }
          if (r2.top < margin) { needAdjust = true; adjustTop = margin; }
          if (r2.right > window.innerWidth - margin) { needAdjust = true; adjustLeft = Math.max(margin, window.innerWidth - r2.width - margin); }
          if (r2.bottom > window.innerHeight - margin) { needAdjust = true; adjustTop = Math.max(margin, window.innerHeight - r2.height - margin); }
          if (needAdjust) { this.root.style.left = `${Math.round(adjustLeft)}px`; this.root.style.top = `${Math.round(adjustTop)}px`; this.root.style.right = this.root.style.bottom = "auto"; }
        });
      } else this._clampToViewport();
    });
  }

  _clampToViewport() {
    const rect = this.root.getBoundingClientRect(); const margin = 8;
    const comp = window.getComputedStyle(this.root);
    let left = parseFloat(comp.left), top = parseFloat(comp.top);
    if (!Number.isFinite(left)) left = rect.left; if (!Number.isFinite(top)) top = rect.top;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop  = Math.max(margin, window.innerHeight - rect.height - margin);
    const clampedLeft = Math.min(Math.max(margin, left), maxLeft);
    const clampedTop  = Math.min(Math.max(margin, top), maxTop);
    this.root.style.left = `${Math.round(clampedLeft)}px`; this.root.style.top = `${Math.round(clampedTop)}px`;
    this.root.style.right = this.root.style.bottom = "auto";
  }

  update({ remaining = 0, total = 1, name = "—", token = null, paused = false, isNPC = false } = {}) {
    if (!this.root) return;
    const portraitMode = S.get("portraitMode") || "token";
    const showPortrait = portraitMode !== "none";
    if (name) this.nameEl.textContent = name;
    this.tokenEl.style.display = (showPortrait && !this.minimized) ? "block" : "none";
    this.nameEl.style.display = this.minimized ? "none" : "block";
    this.timeEl.style.display = this.minimized ? "none" : "block";
    this.timeEl.textContent = String(Math.max(0, remaining));
    const pct = (total && total > 0) ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0;
    this.fillEl.style.width = `${pct}%`;
    const warnAt = Math.max(3, Math.ceil(total * 0.25));
    const dangerAt = Math.max(1, Math.ceil(total * 0.10));
    this.root.dataset.state = (remaining <= dangerAt) ? "danger" : (remaining <= warnAt ? "warn" : "normal");

    const shouldShow = showPortrait && !this.minimized;
    this.tokenEl.style.display = shouldShow ? "block" : "none";

    if (shouldShow) {
      if (token && token !== this._currentTokenSrc) {
        const preload = new Image();
        preload.onload = () => {
          try { this.tokenEl.src = token; this._currentTokenSrc = token; } catch (e) {}
        };
        preload.onerror = () => {
          if (!this._currentTokenSrc) {
            try { this.tokenEl.src = "icons/svg/mystery-man.svg"; this._currentTokenSrc = this.tokenEl.src; } catch (e) {}
          }
        };
        preload.src = token;
      } else if (!token && !this._currentTokenSrc) {
        try { this.tokenEl.src = "icons/svg/mystery-man.svg"; this._currentTokenSrc = this.tokenEl.src; } catch (e) {}
      }
    }

    if (game.user.isGM) { const playBtn = this.root.querySelector(".ct-play"); if (playBtn) playBtn.textContent = paused ? "▶" : "⏸"; }
  }
}

/* --------------------------
   Engine
   -------------------------- */
class CombatTimerEngineClass {
  constructor(moduleKey = MODULE_ID) {
    this.moduleKey = moduleKey;
    this._interval = null;
    this._lastTick = 0;
    this._lastWriteAt = 0;
    this._pendingWrite = null;
    this.writeThrottleMs = 800;

    this.state = {
      running: false,
      endAt: 0,
      paused: false,
      pausedRemaining: 0,
      pausedBySystem: false,
      playersPoolMs: 0,
      playersPoolTotalMs: 0,
      npcPoolMs: 0,
      npcPoolTotalMs: 0,
      tick: 0,
      lastUpdated: 0
    };

    Hooks.once("ready", () => this._setupSocket());

    Hooks.on("updateCombat", (combat, changed) => {
      try {
        const flag = combat?.getFlag?.(this.moduleKey, "state");
        if (flag && !game.user.isGM) {
          this._adoptFlag(flag);
          const active = game.combats?.active;
          if (active && active.id === combat.id) this.start(active);
        }
      } catch (e) {}
    });

    window.CombatTimerEngine = this;
  }

  _now() { return Date.now(); }
  _secondsFor(combatant) { if (!combatant) return Number(game.settings.get(this.moduleKey, "pcSeconds") || 30); return (combatant?.actor?.type && String(combatant.actor.type).toLowerCase() === "npc") ? Number(game.settings.get(this.moduleKey, "npcSeconds") || 15) : Number(game.settings.get(this.moduleKey, "pcSeconds") || 30); }

  _resetPools() {
    const p = Number(game.settings.get(this.moduleKey, "playersPoolSeconds") || 60);
    const n = Number(game.settings.get(this.moduleKey, "npcPoolSeconds") || 60);
    this.state.playersPoolTotalMs = p * 1000; this.state.playersPoolMs = this.state.playersPoolTotalMs;
    this.state.npcPoolTotalMs = n * 1000; this.state.npcPoolMs = this.state.npcPoolTotalMs;
  }

  _serialize() {
    return {
      running: !!this.state.running,
      endAt: Math.max(0, Math.round(this.state.endAt || 0)),
      paused: !!this.state.paused,
      pausedRemaining: Math.max(0, Math.round(this.state.pausedRemaining || 0)),
      pausedBySystem: !!this.state.pausedBySystem,
      playersPoolMs: Math.max(0, Math.round(this.state.playersPoolMs || 0)),
      playersPoolTotalMs: Math.max(0, Math.round(this.state.playersPoolTotalMs || 0)),
      npcPoolMs: Math.max(0, Math.round(this.state.npcPoolMs || 0)),
      npcPoolTotalMs: Math.max(0, Math.round(this.state.npcPoolTotalMs || 0)),
      tick: (this.state.tick || 0),
      lastUpdated: Math.max(0, Math.round(this.state.lastUpdated || 0))
    };
  }

  _adoptFlag(flag) {
    if (!flag) return;
    this.state.running = !!flag.running;
    this.state.endAt = flag.endAt ?? this.state.endAt;
    this.state.paused = !!flag.paused;
    this.state.pausedRemaining = flag.pausedRemaining ?? this.state.pausedRemaining;
    this.state.pausedBySystem = !!flag.pausedBySystem;
    this.state.playersPoolMs = flag.playersPoolMs ?? this.state.playersPoolMs;
    this.state.playersPoolTotalMs = flag.playersPoolTotalMs ?? this.state.playersPoolTotalMs;
    this.state.npcPoolMs = flag.npcPoolMs ?? this.state.npcPoolMs;
    this.state.npcPoolTotalMs = flag.npcPoolTotalMs ?? this.state.npcPoolTotalMs;
    this.state.tick = flag.tick ?? this.state.tick;
    this.state.lastUpdated = flag.lastUpdated ?? this.state.lastUpdated;
  }

  async _writeFlag(combat, immediate = false) {
    if (!game.user.isGM) return;
    this.state.tick = (this.state.tick || 0) + 1; this.state.lastUpdated = this._now();
    const payload = this._serialize();

    const doWrite = async () => {
      this._pendingWrite = null; this._lastWriteAt = this._now();
      try { await combat.setFlag(this.moduleKey, "state", payload); }
      catch (e) { console.warn(`[${this.moduleKey}] write flag failed`, e); }
    };

    if (immediate) {
      if (this._pendingWrite) { clearTimeout(this._pendingWrite); this._pendingWrite = null; }
      await doWrite(); return;
    }

    const since = this._now() - (this._lastWriteAt || 0);
    if (since >= this.writeThrottleMs) await doWrite();
    else {
      if (this._pendingWrite) clearTimeout(this._pendingWrite);
      this._pendingWrite = setTimeout(doWrite, this.writeThrottleMs - since + 5);
    }
  }

  _computeTokenImgForCombatant(cbt) {
    const portraitMode = game.settings.get(this.moduleKey, "portraitMode") || "token";
    let tokenImg = null;
    if (portraitMode === "token") tokenImg = cbt?.token?.texture?.src || cbt?.actor?.prototypeToken?.texture?.src || null;
    else if (portraitMode === "portrait") tokenImg = cbt?.actor?.img || cbt?.actor?.prototypeToken?.texture?.src || cbt?.token?.texture?.src || null;
    if ((portraitMode === "token" || portraitMode === "portrait") && !tokenImg) tokenImg = "icons/svg/mystery-man.svg";
    if (portraitMode === "none") tokenImg = null;
    return tokenImg;
  }

  async start(combat) {
    if (!combat?.started) return this.stop();
    if (!this.state.playersPoolTotalMs || !this.state.npcPoolTotalMs) this._resetPools();

    const cbt = combat.combatant; const perTurn = this._secondsFor(cbt);

    if (game.user.isGM) {
      const isNpc = (cbt && cbt.actor && String(cbt.actor.type).toLowerCase() === "npc");
      const playersMode = String(game.settings.get(this.moduleKey, "playersMode") || "normal");
      const npcMode = String(game.settings.get(this.moduleKey, "npcMode") || "normal");

      if (!isNpc && playersMode === "shared") this.state.endAt = this._now() + this.state.playersPoolMs;
      else if (isNpc && npcMode === "shared") this.state.endAt = this._now() + this.state.npcPoolMs;
      else this.state.endAt = this._now() + (perTurn * 1000);

      const startPaused = !!combat.getFlag?.(this.moduleKey, "startPaused");
      if ((typeof game?.paused !== "undefined" ? game.paused : false) || startPaused) {
        this.state.pausedBySystem = true;
        this.state.paused = true;
        const msLeft = Math.max(0, this.state.endAt - this._now()); this.state.pausedRemaining = Math.ceil(msLeft / 1000);
      } else {
        this.state.paused = false; this.state.pausedRemaining = 0; this.state.pausedBySystem = false;
      }

      this.state.running = true; this.state.tick = (this.state.tick || 0) + 1; this.state.lastUpdated = this._now();
      await this._writeFlag(combat, true);

      if (startPaused) {
        try { await combat.unsetFlag(this.moduleKey, "startPaused"); } catch (e) {}
      }
    } else {
      const flag = combat.getFlag?.(this.moduleKey, "state");
      if (flag) this._adoptFlag(flag);
      else {
        if (!this.state.playersPoolTotalMs || !this.state.npcPoolTotalMs) this._resetPools();
        this.state.endAt = this._now() + (perTurn * 1000);
        this.state.paused = false; this.state.pausedRemaining = 0; this.state.pausedBySystem = false; this.state.running = true;
      }
    }

    const tokenImg = this._computeTokenImgForCombatant(cbt);

    ui.combatTimerHUD?.applyFixedMode();
    ui.combatTimerHUD?.applyScaleAndClamp();

    const hud = this._computeHud(combat);
    if (hud.hidden) ui.combatTimerHUD?.hide();
    else {
      ui.combatTimerHUD?.update({ remaining: hud.remaining, total: hud.total, name: cbt?.name ?? "—", token: tokenImg, paused: !!this.state.paused, isNPC: hud.isNpc });
      ui.combatTimerHUD?.show();
    }

    this._lastTick = this._now();
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => this._tick(combat, perTurn, tokenImg), 200);
  }

  stop() { if (this._interval) { clearInterval(this._interval); this._interval = null; } }

  async reset(combat = game.combats?.active) {
    if (!combat?.started) return;
    const cbt = combat.combatant; if (!cbt) return;

    if (game.user.isGM) {
      const isNpc = (cbt && cbt.actor && String(cbt.actor.type).toLowerCase() === "npc");
      const playersMode = String(game.settings.get(this.moduleKey, "playersMode") || "normal");
      const npcMode = String(game.settings.get(this.moduleKey, "npcMode") || "normal");

      if (playersMode === "shared") { this.state.playersPoolMs = this.state.playersPoolTotalMs; if (!isNpc) this.state.endAt = this._now() + this.state.playersPoolMs; }
      if (npcMode === "shared") { this.state.npcPoolMs = this.state.npcPoolTotalMs; if (isNpc) this.state.endAt = this._now() + this.state.npcPoolMs; }

      if (!(playersMode === "shared" && !isNpc) && !(npcMode === "shared" && isNpc)) {
        const perTurn = this._secondsFor(cbt);
        this.state.endAt = this._now() + (perTurn * 1000);
      }

      this.state.paused = false; this.state.pausedRemaining = 0; this.state.pausedBySystem = false;
      this.state.running = true; this.state.tick = (this.state.tick || 0) + 1; this.state.lastUpdated = this._now();
      await this._writeFlag(combat, true);

      const tokenImg = this._computeTokenImgForCombatant(cbt);
      const hud = this._computeHud(combat);
      if (hud.hidden) ui.combatTimerHUD?.hide();
      else ui.combatTimerHUD?.update({ remaining: hud.remaining, total: hud.total, name: cbt?.name ?? "—", token: tokenImg, paused: !!this.state.paused, isNPC: hud.isNpc });
      return;
    }

    try {
      game.socket.emit(`module.${this.moduleKey}`, { action: "requestReset", combatId: combat.id, turn: combat.turn, userId: game.user.id });
    } catch (e) { console.warn(`[${this.moduleKey}] socket emit failed`, e); }
  }

  async togglePause(combat = game.combats?.active, force = null) {
    if (!combat) return;
    if (!game.user.isGM) return;

    if (force === true) {
      if (!this.state.paused) {
        const msLeft = Math.max(0, this.state.endAt - this._now()); this.state.pausedRemaining = Math.ceil(msLeft / 1000);
      }
      this.state.paused = true;
      this.state.pausedBySystem = false;
    } else if (force === false) {
      this.state.endAt = this._now() + (this.state.pausedRemaining * 1000); this.state.paused = false;
      this.state.pausedBySystem = false;
    } else {
      if (this.state.paused) {
        this.state.endAt = this._now() + (this.state.pausedRemaining * 1000); this.state.paused = false;
        this.state.pausedBySystem = false;
      } else {
        const msLeft = Math.max(0, this.state.endAt - this._now()); this.state.pausedRemaining = Math.ceil(msLeft / 1000); this.state.paused = true;
        this.state.pausedBySystem = false;
      }
    }

    this.state.lastUpdated = this._now(); this.state.tick = (this.state.tick || 0) + 1;
    await this._writeFlag(combat, true);
  }

  systemPause(combat = game.combats?.active) {
    if (!combat) return;
    if (this.state.paused) { this.state.pausedBySystem = true; return; }
    const msLeft = Math.max(0, this.state.endAt - this._now()); this.state.pausedRemaining = Math.ceil(msLeft / 1000);
    this.state.paused = true; this.state.pausedBySystem = true; this.state.lastUpdated = this._now();
    if (game.user.isGM) this._writeFlag(combat, true);
  }

  systemResume(combat = game.combats?.active) {
    if (!combat) return;
    if (!this.state.paused || !this.state.pausedBySystem) return;
    this.state.endAt = this._now() + (this.state.pausedRemaining * 1000);
    this.state.paused = false; this.state.pausedBySystem = false; this.state.lastUpdated = this._now();
    if (game.user.isGM) this._writeFlag(combat, true);
  }

  async _tick(combat, perTurnSec, tokenImg) {
    if (!combat || combat.id !== (game.combats?.active?.id)) { if (combat?.started) this.start(combat); else this.stop(); return; }
    const now = this._now(); const deltaMs = Math.max(0, now - (this._lastTick || now));
    this._lastTick = now;

    const cbt = combat.combatant; const isNpc = !!(cbt && cbt.actor && String(cbt.actor.type).toLowerCase() === "npc");
    const playersMode = String(game.settings.get(this.moduleKey, "playersMode") || "normal");
    const npcMode = String(game.settings.get(this.moduleKey, "npcMode") || "normal");

    if (game.user.isGM && !this.state.paused) {
      if (!isNpc && playersMode === "shared") this.state.playersPoolMs = Math.max(0, this.state.playersPoolMs - deltaMs);
      else if (isNpc && npcMode === "shared") this.state.npcPoolMs = Math.max(0, this.state.npcPoolMs - deltaMs);
    }

    const hud = this._computeHud(combat);
    if (hud.hidden) { ui.combatTimerHUD?.hide(); return; }

    ui.combatTimerHUD?.update({ remaining: hud.remaining, total: hud.total, name: cbt?.name ?? "—", token: tokenImg, paused: !!this.state.paused, isNPC: hud.isNpc });

    const warningPct = Number(game.settings.get(this.moduleKey, "warningThreshold") || 20);
    const warnTime = Math.ceil(hud.total * (warningPct / 100));
    if (!this._warningPlayed && hud.remaining <= warnTime && hud.remaining > 0) {
      const wkey = hud.isNpc ? "warningSoundNPC" : "warningSoundPC"; const s = game.settings.get(this.moduleKey, wkey); if (s) AudioHelper.play({ src: s, volume: 0.6, autoplay: true, loop: false }, true);
      this._warningPlayed = true;
    }

    let expired = false;
    if (!isNpc && playersMode === "shared") expired = (this.state.playersPoolMs <= 0);
    else if (isNpc && npcMode === "shared") expired = (this.state.npcPoolMs <= 0);
    else expired = (!this.state.paused && (this.state.endAt - now) <= 0);

    if (expired) {
      const skey = hud.isNpc ? "timeoutSoundNPC" : "timeoutSoundPC"; const s2 = game.settings.get(this.moduleKey, skey); if (s2) AudioHelper.play({ src: s2, volume: 0.8, autoplay: true, loop: false }, true);
      if (game.user.isGM) { try { await combat.nextTurn(); } catch (e) { console.error(`[${this.moduleKey}] nextTurn failed`, e); } }
      this.stop(); return;
    }

    if (game.user.isGM) {
      const since = now - (this._lastWriteAt || 0);
      if (since >= this.writeThrottleMs) await this._writeFlag(combat);
    }
  }

  _computeHud(combat) {
    const cbt = combat?.combatant;
    const perTurn = this._secondsFor(cbt);
    const isNpc = !!(cbt && cbt.actor && String(cbt.actor.type).toLowerCase() === "npc");
    const playersMode = String(game.settings.get(this.moduleKey, "playersMode") || "normal");
    const npcMode = String(game.settings.get(this.moduleKey, "npcMode") || "normal");

    if (!isNpc && playersMode === "disabled") return { hidden: true };
    if (isNpc && npcMode === "disabled") return { hidden: true };

    if (!isNpc && playersMode === "shared") {
      const total = Math.max(1, Math.ceil((this.state.playersPoolTotalMs || perTurn*1000) / 1000));
      const remaining = Math.max(0, Math.ceil((this.state.playersPoolMs || 0) / 1000));
      return { hidden: false, total, remaining, isNpc: false };
    }

    if (isNpc && npcMode === "shared") {
      const total = Math.max(1, Math.ceil((this.state.npcPoolTotalMs || perTurn*1000) / 1000));
      const remaining = Math.max(0, Math.ceil((this.state.npcPoolMs || 0) / 1000));
      return { hidden: false, total, remaining, isNpc: true };
    }

    if (this.state.paused) return { hidden: false, total: Math.max(1, perTurn), remaining: Math.max(0, Math.ceil(this.state.pausedRemaining || 0)), isNpc };
    const remaining = Math.max(0, Math.ceil((this.state.endAt - this._now()) / 1000));
    return { hidden: false, total: Math.max(1, perTurn), remaining, isNpc };
  }

  _setupSocket() {
    try {
      game.socket.on(`module.${this.moduleKey}`, async (data) => {
        if (!data || typeof data !== "object") return;
        if (data.action === "requestReset") {
          if (!game.user.isGM) return;
          const { combatId, turn, userId } = data;
          const combat = game.combats?.get(combatId);
          if (!combat) return;
          if (combat.turn !== turn) return;
          const cbt = combat.combatant; if (!cbt) return;
          const sender = game.users?.get(userId); if (!sender) return;
          const actor = cbt.actor;
          const ownerPerm = actor?.permission?.[userId] ?? 0;
          const isOwner = ownerPerm >= CONST.DOCUMENT_PERMISSION_LEVELS.OWNER || actor?.hasPlayerOwner === true;
          if (!sender.isGM && !isOwner) return;
          try { await this.reset(combat); }
          catch (e) { console.error(`[${this.moduleKey}] failed to apply requested reset`, e); }
        }
      });
    } catch (e) { console.warn(`[${this.moduleKey}] socket setup failed`, e); }
  }
}

if (!window.CombatTimerEngine) window.CombatTimerEngine = new CombatTimerEngineClass(MODULE_ID);
const CombatTimerEngine = window.CombatTimerEngine;

/* --------------------------
   Settings & menus
   -------------------------- */
Hooks.once("init", () => {
  // core
  game.settings.register(MODULE_ID, "pcSeconds", { name: "Turn Timer (Players, seconds)", scope: "world", config: true, type: Number, default: 30, range: { min: 1, max: 600, step: 1 } });
  game.settings.register(MODULE_ID, "npcSeconds", { name: "Turn Timer (NPCs, seconds)", scope: "world", config: true, type: Number, default: 15, range: { min: 1, max: 600, step: 1 } });
  game.settings.register(MODULE_ID, "playersMode", { name: "Players Timer Mode", hint: "Disabled | Normal | Shared", scope: "world", config: true, type: String, default: "normal", choices: { "disabled": "Disabled", "normal": "Normal", "shared": "Shared" } });
  game.settings.register(MODULE_ID, "npcMode",     { name: "NPC Timer Mode", hint: "Disabled | Normal | Shared", scope: "world", config: true, type: String, default: "normal", choices: { "disabled": "Disabled", "normal": "Normal", "shared": "Shared" } });
  game.settings.register(MODULE_ID, "playersPoolSeconds", { name: "Players Shared Pool (seconds)", scope: "world", config: true, type: Number, default: 60, range: { min: 5, max: 3600, step: 1 } });
  game.settings.register(MODULE_ID, "npcPoolSeconds",     { name: "NPC Shared Pool (seconds)",     scope: "world", config: true, type: Number, default: 60, range: { min: 5, max: 3600, step: 1 } });

  game.settings.register(MODULE_ID, "timeoutSoundPC", { name: "Timeout Sound (PC)", scope: "world", config: true, type: String, default: "sounds/clock.wav", filePicker: "audio" });
  game.settings.register(MODULE_ID, "timeoutSoundNPC", { name: "Timeout Sound (NPC)", scope: "world", config: true, type: String, default: "sounds/skip.wav", filePicker: "audio" });
  game.settings.register(MODULE_ID, "warningSoundPC", { name: "Warning Sound (PC)", scope: "world", config: true, type: String, default: "", filePicker: "audio" });
  game.settings.register(MODULE_ID, "warningSoundNPC", { name: "Warning Sound (NPC)", scope: "world", config: true, type: String, default: "", filePicker: "audio" });

  game.settings.register(MODULE_ID, "warningThreshold", { name: "Warning Threshold (%)", scope: "world", config: true, type: Number, default: 20, range: { min: 1, max: 100, step: 1 } });
  game.settings.register(MODULE_ID, "startCombatPaused", { name: "Start combat paused", hint: "When enabled, combat begins paused.", scope: "world", config: true, type: Boolean, default: true });

  game.settings.register(MODULE_ID, "autoShow", { name: "Show HUD when combat starts", scope: "client", config: true, type: Boolean, default: true });
  game.settings.register(MODULE_ID, "fixedModeGM", { name: "Fixed HUD Mode (GM)", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MODULE_ID, "fixedModePlayers", { name: "Fixed HUD Mode (Players)", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MODULE_ID, "fixedPosition", { name: "Fixed HUD Position", scope: "world", config: true, type: String, default: "bottom-right", choices: { "top-left":"Top Left", "top-right":"Top Right", "bottom-left":"Bottom Left", "bottom-right":"Bottom Right" } });
  game.settings.register(MODULE_ID, "hudScale", { name: "HUD Scale", scope: "client", config: true, type: Number, default: 1.0, range: { min: 0.5, max: 2.0, step: 0.1 } });
  game.settings.register(MODULE_ID, "portraitMode", { name: "Portrait Mode", hint: "None = no image; Portrait = actor portrait; Token = token artwork", scope: "client", config: true, type: String, default: "token", choices: { "none":"None","portrait":"Portrait","token":"Token" } });

  game.settings.register(MODULE_ID, "hudPosition", { name: "HUD position & state (per-client)", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "hudStyle", { name: "HUD Style (selected file)", scope: "client", config: false, type: String, default: "" });

  game.settings.register(MODULE_ID, "forceStyleByGM", { name: "Force HUD style for players (GM only)", hint: "When enabled, players will be forced to use the GM-selected HUD style.", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MODULE_ID, "gmHudStyle", { name: "GM HUD Style (file)", scope: "world", config: false, type: String, default: "" });

  // offsets (hidden from base settings UI; edited via menu)
  game.settings.register(MODULE_ID, "playerOffsetHPercent", { name: "Players: Horizontal offset (%)", scope: "world", config: false, type: Number, default: 0, range: { min: -50, max: 50, step: 1 } });
  game.settings.register(MODULE_ID, "playerOffsetVPercent", { name: "Players: Vertical offset (%)", scope: "world", config: false, type: Number, default: 0, range: { min: -50, max: 50, step: 1 } });
  game.settings.register(MODULE_ID, "gmOffsetHPercent", { name: "GM: Horizontal offset (%)", scope: "client", config: false, type: Number, default: 0, range: { min: -50, max: 50, step: 1 } });
  game.settings.register(MODULE_ID, "gmOffsetVPercent", { name: "GM: Vertical offset (%)", scope: "client", config: false, type: Number, default: 0, range: { min: -50, max: 50, step: 1 } });

  // Styles Menu (same as before)
  game.settings.registerMenu(MODULE_ID, "stylesMenu", {
    name: "Timer HUD Styles",
    label: "Choose style",
    hint: "Select and preview available HUD styles from the module styles/ folder.",
    icon: "fas fa-palette",
    type: class StylesSelector extends FormApplication {
      static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
          id: "ct-styles-selector",
          title: "Timer HUD Styles",
          template: null,
          width: 760,
          height: "auto",
          closeOnSubmit: true
        });
      }

      async getData() {
        const available = await Styles.loadAvailableStyles();
        const current = game.settings.get(MODULE_ID, "hudStyle") || "";
        const force = game.settings.get(MODULE_ID, "forceStyleByGM") || false;
        const gm = game.settings.get(MODULE_ID, "gmHudStyle") || "";
        return { available, current, force, gm };
      }

      async render(forceRender = false) {
        const { available, current, force, gm } = await this.getData();
        const isGM = game.user.isGM;

        let effectivePreviewStyle = null;
        if (force && !isGM) effectivePreviewStyle = (available.find(x => x.file === gm) || null);
        else effectivePreviewStyle = (available.find(x => x.file === current) || available[0] || null);

        let selectAttrs = "";
        if (force && !isGM) selectAttrs = "disabled";

        let optionsHtml = "";
        for (const s of available) {
          const selected = (s.file === current) ? "selected" : "";
          optionsHtml += `<option value="${s.file}" ${selected}>${s.name}</option>`;
        }

        const previewHtml = effectivePreviewStyle && effectivePreviewStyle.preview ? `<img src="${Styles._stylesDir()}${effectivePreviewStyle.preview}" style="max-width:100%;max-height:260px;border-radius:6px">` : "<div style='color:#bbb'>No preview available</div>";
        const descHtml = effectivePreviewStyle ? (effectivePreviewStyle.description || "<div style='color:#bbb'>No description provided.</div>") : "<div style='color:#bbb'>No description provided.</div>";

        const gmControlsHtml = isGM ? `
          <div style="margin-top:10px;display:flex;gap:10px;align-items:center;">
            <label style="display:flex;gap:8px;align-items:center;">
              <input type="checkbox" id="ct-force-checkbox" ${force ? "checked" : ""}>
              <span>Force this style for players</span>
            </label>
            <div style="color:#bbb;font-size:12px;">When checked, players will be forced to use the GM-selected style.</div>
          </div>
        ` : "";

        const nonGmForceNote = (!isGM && force) ? `<div style="margin-top:10px;padding:8px;border-radius:6px;background:#111;color:#ddd;border:1px solid #222;">Style selection is locked by the GM. Showing GM-chosen style: <strong>${(available.find(x=>x.file===gm)?.name)||gm||"Unknown"}</strong></div>` : "";

        const content = `
          <div style="padding:14px;font-size:13px;">
            <div style="display:flex;gap:14px;align-items:flex-start;">
              <div style="flex:1;min-width:320px;">
                <label style="font-weight:600;">Available styles</label>
                <select id="ct-style-select" ${selectAttrs} style="width:100%;margin-top:8px;padding:8px;font-size:13px;height:36px;">${optionsHtml}</select>

                <div id="ct-style-desc" style="margin-top:12px;background:rgba(0,0,0,0.68);color:#f1f1f1;padding:8px;border-radius:8px;min-height:48px;line-height:1.2;">
                  ${descHtml}
                </div>

                <div id="ct-actions" style="margin-top:10px;display:flex;gap:10px;align-items:center;">
                  <button id="ct-apply-inner" class="button" ${(!isGM && force) ? "disabled" : ""}>Apply</button>
                  <button id="ct-reload-inner" class="button">Reload</button>
                </div>

                ${gmControlsHtml}
                ${nonGmForceNote}
              </div>

              <div style="width:340px;min-width:240px;">
                <label style="font-weight:600;">Preview</label>
                <div id="ct-style-preview" style="margin-top:8px;height:260px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:#111;padding:8px;border:1px solid #222;">
                  ${previewHtml}
                </div>
              </div>
            </div>
          </div>
        `;

        return new Promise(resolve => {
          const dlg = new Dialog({
            title: this.options.title,
            content,
            buttons: {},
            default: ""
          }, { width: 760 }).render(true);

          // Wait for DOM to be ready, then attach events
          const tryBind = () => {
            const selector = `.ui-dialog[aria-label="${this.options.title}"]`;
            const dialogDiv = document.querySelector(selector) || document.querySelector(".dialog:not([data-ctbound])");
            if (!dialogDiv) {
              // try again shortly (gives time for Dialog to insert)
              setTimeout(() => {
                const dialogDiv2 = document.querySelector(selector) || document.querySelector(".dialog:not([data-ctbound])");
                if (dialogDiv2) bind(dialogDiv2); else resolve();
              }, 60);
              return;
            }
            bind(dialogDiv);
          };

          const bind = (dialogDiv) => {
            if (!dialogDiv) { resolve(); return; }
            if (dialogDiv.getAttribute("data-ctbound")) { resolve(); return; }
            dialogDiv.setAttribute("data-ctbound", "1");

            const selEl = dialogDiv.querySelector("#ct-style-select");
            const previewEl = dialogDiv.querySelector("#ct-style-preview");
            const descEl = dialogDiv.querySelector("#ct-style-desc");
            const applyBtn = dialogDiv.querySelector("#ct-apply-inner");
            const reloadBtn = dialogDiv.querySelector("#ct-reload-inner");
            const forceCheckbox = dialogDiv.querySelector("#ct-force-checkbox");

            const cleanupAndResolve = (val) => {
              try { dlg.close(); } catch (e) {}
              resolve(val);
            };

            selEl?.addEventListener("change", (ev) => {
              const val = ev.target.value;
              const s = (available.find(x => x.file === val) || null);
              if (s && s.preview) previewEl.innerHTML = `<img src="${Styles._stylesDir()}${s.preview}" style="max-width:100%;max-height:260px;border-radius:6px">`;
              else previewEl.innerHTML = `<div style="color:#bbb">No preview available</div>`;
              if (s && s.description) descEl.innerHTML = `<div style="white-space:pre-wrap;">${s.description}</div>`;
              else descEl.innerHTML = `<div style="color:#bbb">No description provided.</div>`;
            });

            applyBtn?.addEventListener("click", async () => {
              const sel = selEl?.value;
              if (!sel) { ui.notifications.warn("No style selected"); return; }

              if (isGM) {
                const wantForce = !!(forceCheckbox?.checked);
                try {
                  await game.settings.set(MODULE_ID, "gmHudStyle", sel);
                  await game.settings.set(MODULE_ID, "forceStyleByGM", wantForce);
                } catch (e) { console.warn(`[${MODULE_ID}] failed to set GM style/force`, e); }

                await Styles.loadStyle(sel, true);
                ui.notifications.info("Style applied (GM)");

                try {
                  game.socket.emit(`module.${MODULE_ID}`, { action: "forceStyle", file: wantForce ? sel : null });
                } catch (e) { console.warn(`[${MODULE_ID}] failed to broadcast forceStyle`, e); }

                cleanupAndResolve();
                return;
              }

              try {
                await Styles.loadStyle(sel, true);
                ui.notifications.info("Style applied");
              } catch (e) { console.warn(`[${MODULE_ID}] load style failed`, e); }
              cleanupAndResolve();
            });

            reloadBtn?.addEventListener("click", async () => {
              try { dlg.close(); } catch(e) {}
              this.render(true).then(() => resolve());
            });

            const onDocClick = (ev) => {
              if (!dialogDiv) return;
              if (dialogDiv.contains(ev.target)) return;
              cleanupAndResolve();
            };
            document.addEventListener("mousedown", onDocClick);

            const onKeyDown = (ev) => { if (ev.key === "Escape") cleanupAndResolve(); };
            document.addEventListener("keydown", onKeyDown);
          };

          tryBind();
        });
      }
    }
  });

  // Offsets Menu (GM only) — robust Dialog implementation
  game.settings.registerMenu(MODULE_ID, "offsetsMenu", {
    name: "HUD Offsets (GM only)",
    label: "Offsets (GM only)",
    hint: "Edit percent-based offsets for players (world) and GM personal offsets (client). Only GMs may save changes.",
    icon: "fas fa-arrows-alt",
    type: class OffsetsSelector extends FormApplication {
      static get defaultOptions() {
        return mergeObject(super.defaultOptions, {
          id: "ct-offsets-selector",
          title: "HUD Offsets (GM only)",
          template: null,
          width: 520,
          height: "auto",
          closeOnSubmit: true
        });
      }

      async getData() {
        const playerH = Number(game.settings.get(MODULE_ID, "playerOffsetHPercent") || 0);
        const playerV = Number(game.settings.get(MODULE_ID, "playerOffsetVPercent") || 0);
        const gmH = Number(game.settings.get(MODULE_ID, "gmOffsetHPercent") || 0);
        const gmV = Number(game.settings.get(MODULE_ID, "gmOffsetVPercent") || 0);
        const fixedPos = String(game.settings.get(MODULE_ID, "fixedPosition") || "bottom-right");
        const isGM = game.user.isGM;
        return { playerH, playerV, gmH, gmV, fixedPos, isGM };
      }

      // Render -> create a Dialog and bind reliably to it.
      async render(force = false) {
        const { playerH, playerV, gmH, gmV, fixedPos, isGM } = await this.getData();

        const contentGM = `
          <div style="padding:14px;font-size:13px;">
            <div style="display:flex;flex-direction:column;gap:8px;">
              <div style="font-weight:700;">Global player offsets (applied to players)</div>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="width:160px;">Horizontal (%)</label>
                <input id="ct-player-h" type="range" min="-50" max="50" value="${playerH}" style="flex:1;">
                <input id="ct-player-h-num" type="number" value="${playerH}" style="width:72px;margin-left:8px;">
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="width:160px;">Vertical (%)</label>
                <input id="ct-player-v" type="range" min="-50" max="50" value="${playerV}" style="flex:1;">
                <input id="ct-player-v-num" type="number" value="${playerV}" style="width:72px;margin-left:8px;">
              </div>

              <hr style="margin:12px 0;border-color:#222">

              <div style="font-weight:700;">GM personal offsets (your client)</div>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="width:160px;">Horizontal (%)</label>
                <input id="ct-gm-h" type="range" min="-50" max="50" value="${gmH}" style="flex:1;">
                <input id="ct-gm-h-num" type="number" value="${gmH}" style="width:72px;margin-left:8px;">
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                <label style="width:160px;">Vertical (%)</label>
                <input id="ct-gm-v" type="range" min="-50" max="50" value="${gmV}" style="flex:1;">
                <input id="ct-gm-v-num" type="number" value="${gmV}" style="width:72px;margin-left:8px;">
              </div>

              <div style="margin-top:10px;display:flex;gap:8px;">
                <button id="ct-offset-save" class="button">Save</button>
                <button id="ct-offset-cancel" class="button">Close</button>
              </div>

              <div style="margin-top:8px;color:#999;font-size:12px;">
                Fixed anchor: <strong>${fixedPos}</strong>.
              </div>
            </div>
          </div>
        `;

        const contentNonGM = `
          <div style="padding:14px;font-size:13px;">
            <div style="padding:12px;border-radius:6px;background:#111;border:1px solid #222;color:#ddd;">
              Offsets may only be edited by a GM. Ask your GM to change HUD offsets if you need a different placement.
            </div>
            <div style="margin-top:10px;color:#999;font-size:12px;">Fixed anchor: <strong>${fixedPos}</strong>.</div>
          </div>
        `;

        const dialogContent = isGM ? contentGM : contentNonGM;

        return new Promise(resolve => {
          const dlg = new Dialog({
            title: this.options.title,
            content: dialogContent,
            buttons: {},
            default: ""
          }, { width: this.options.width }).render(true);

          // After render, bind to dialog
          const bindAfter = () => {
            const selector = `.ui-dialog[aria-label="${this.options.title}"]`;
            const dialogDiv = document.querySelector(selector) || document.querySelector(".dialog:not([data-ctbound])");
            if (!dialogDiv) {
              setTimeout(() => {
                const dialogDiv2 = document.querySelector(selector) || document.querySelector(".dialog:not([data-ctbound])");
                if (!dialogDiv2) { resolve(); return; }
                attach(dialogDiv2);
              }, 40);
              return;
            }
            attach(dialogDiv);
          };

          const attach = (dialogDiv) => {
            if (!dialogDiv) { resolve(); return; }
            if (dialogDiv.getAttribute("data-ctbound")) { resolve(); return; }
            dialogDiv.setAttribute("data-ctbound", "1");

            const cleanup = () => { try { dlg.close(); } catch(e) {} ; resolve(); };

            // Remove native titlebar close so user uses our Close button
            const titleClose = dialogDiv.querySelector(".ui-dialog-titlebar-close");
            if (titleClose) titleClose.remove();

            if (!isGM) {
              // clicking outside or ESC closes
              const onDocClick = (ev) => { if (!dialogDiv) return; if (dialogDiv.contains(ev.target)) return; cleanup(); };
              document.addEventListener("mousedown", onDocClick);
              const onKeyDown = (ev) => { if (ev.key === "Escape") cleanup(); };
              document.addEventListener("keydown", onKeyDown);
              return;
            }

            // GM control bindings
            const inPlayerH = dialogDiv.querySelector("#ct-player-h");
            const inPlayerV = dialogDiv.querySelector("#ct-player-v");
            const inPlayerHnum = dialogDiv.querySelector("#ct-player-h-num");
            const inPlayerVnum = dialogDiv.querySelector("#ct-player-v-num");
            const inGmH = dialogDiv.querySelector("#ct-gm-h");
            const inGmV = dialogDiv.querySelector("#ct-gm-v");
            const inGmHnum = dialogDiv.querySelector("#ct-gm-h-num");
            const inGmVnum = dialogDiv.querySelector("#ct-gm-v-num");
            const saveBtn = dialogDiv.querySelector("#ct-offset-save");
            const cancelBtn = dialogDiv.querySelector("#ct-offset-cancel");

            const syncRangeToNum = (rangeEl, numEl) => {
              if (!rangeEl || !numEl) return;
              rangeEl.addEventListener("input", () => { numEl.value = rangeEl.value; });
              numEl.addEventListener("input", () => { const v = Number(numEl.value || 0); rangeEl.value = String(Math.max(-50, Math.min(50, Math.round(v)))); });
            };
            syncRangeToNum(inPlayerH, inPlayerHnum);
            syncRangeToNum(inPlayerV, inPlayerVnum);
            syncRangeToNum(inGmH, inGmHnum);
            syncRangeToNum(inGmV, inGmVnum);

            saveBtn?.addEventListener("click", async () => {
              const ph = Number(inPlayerHnum?.value || 0);
              const pv = Number(inPlayerVnum?.value || 0);
              const gh = Number(inGmHnum?.value || 0);
              const gv = Number(inGmVnum?.value || 0);
              const clamp = (v) => Math.max(-50, Math.min(50, Math.round(v)));
              try {
                await game.settings.set(MODULE_ID, "playerOffsetHPercent", clamp(ph));
                await game.settings.set(MODULE_ID, "playerOffsetVPercent", clamp(pv));
                await game.settings.set(MODULE_ID, "gmOffsetHPercent", clamp(gh));
                await game.settings.set(MODULE_ID, "gmOffsetVPercent", clamp(gv));
                ui.notifications.info("Offsets saved.");
                ui.combatTimerHUD?.applyScaleAndClamp();
              } catch (e) {
                console.warn(`[${MODULE_ID}] failed to save offsets`, e);
                ui.notifications.error("Failed to save offsets.");
              }
              cleanup();
            });

            cancelBtn?.addEventListener("click", cleanup);

            const onDocClick = (ev) => { if (!dialogDiv) return; if (dialogDiv.contains(ev.target)) return; cleanup(); };
            document.addEventListener("mousedown", onDocClick);
            const onKeyDown = (ev) => { if (ev.key === "Escape") cleanup(); };
            document.addEventListener("keydown", onKeyDown);
          };

          bindAfter();
        });
      }
    }
  });

});

/* --------------------------
   Ready & Hooks
   -------------------------- */
Hooks.once("ready", async () => {
  ui.combatTimerHUD = new CombatTimerHUD();
  await Styles.applyCurrent();

  try {
    game.socket.on(`module.${MODULE_ID}`, (data) => {
      if (!data || typeof data !== "object") return;
      if (data.action !== "forceStyle") return;
      const force = game.settings.get(MODULE_ID, "forceStyleByGM");
      if (!force) return;
      if (game.user.isGM) return;
      const file = data.file;
      if (file) Styles.loadStyle(file, false);
      else {
        const cur = game.settings.get(MODULE_ID, "hudStyle") || "";
        if (cur) Styles.loadStyle(cur, false);
        else Styles.unloadStyle(false);
      }
    });
  } catch (e) { console.warn(`[${MODULE_ID}] socket forceStyle listener failed`, e); }

  const active = game.combats?.active;
  const startPausedEnabled = S.get("startCombatPaused");
  if (active?.started && (active.combatants?.size ?? 0) > 0) {
    CombatTimerEngine._resetPools();
    if (startPausedEnabled && !game.user.isGM) {
      const pollFlagThenStart = (attempt = 0) => {
        const flag = active.getFlag?.(MODULE_ID, "startPaused");
        const timerFlag = active.getFlag?.(MODULE_ID, "state");
        if (timerFlag || flag || attempt >= 10) {
          CombatTimerEngine.start(active);
        } else setTimeout(() => pollFlagThenStart(attempt + 1), 100);
      };
      pollFlagThenStart();
    } else {
      CombatTimerEngine.start(active);
    }
  } else {
    if (active?.started && (active.combatants?.size ?? 0) === 0) ui.combatTimerHUD?.hide();
  }
});

Hooks.on("combatStart", (combat) => {
  if ((combat.combatants?.size ?? 0) === 0) { ui.combatTimerHUD?.hide(); return; }
  CombatTimerEngine._resetPools();

  const startPausedEnabled = S.get("startCombatPaused");

  if (startPausedEnabled) {
    if (game.user.isGM) {
      combat.setFlag(MODULE_ID, "startPaused", true).then(() => { CombatTimerEngine.start(combat); }).catch((e) => { console.warn(`[${MODULE_ID}] setFlag startPaused failed`, e); CombatTimerEngine.start(combat); });
    } else {
      const poll = (attempt = 0) => {
        const flag = combat.getFlag?.(MODULE_ID, "startPaused");
        const timerFlag = combat.getFlag?.(MODULE_ID, "state");
        if (timerFlag || flag || attempt >= 10) { CombatTimerEngine.start(combat); } else setTimeout(() => poll(attempt + 1), 100);
      };
      poll();
    }
  } else {
    CombatTimerEngine.start(combat);
  }
});

Hooks.on("combatTurn", (combat) => {
  if ((combat.combatants?.size ?? 0) > 0) CombatTimerEngine.start(combat);
  else { CombatTimerEngine.stop(); ui.combatTimerHUD?.hide(); }
});

Hooks.on("updateCombat", (combat, changed) => {
  if ("started" in changed && changed.started === true) {
    if ((combat.combatants?.size ?? 0) > 0) {
      CombatTimerEngine._resetPools();
      const startPausedEnabled = S.get("startCombatPaused");
      if (startPausedEnabled) {
        if (game.user.isGM) {
          combat.setFlag(MODULE_ID, "startPaused", true).then(() => { CombatTimerEngine.start(combat); }).catch(() => { CombatTimerEngine.start(combat); });
        } else {
          const poll = (attempt = 0) => {
            const flag = combat.getFlag?.(MODULE_ID, "startPaused");
            const timerFlag = combat.getFlag?.(MODULE_ID, "state");
            if (timerFlag || flag || attempt >= 10) { CombatTimerEngine.start(combat); } else setTimeout(() => poll(attempt + 1), 100);
          };
          poll();
        }
      } else { CombatTimerEngine.start(combat); }
    } else ui.combatTimerHUD?.hide();
  }
  if ("round" in changed) {
    CombatTimerEngine._resetPools();
    if (combat.started && (combat.combatants?.size ?? 0) > 0) CombatTimerEngine.start(combat);
  }
  if ("turn" in changed || "round" in changed) {
    if ((combat.combatants?.size ?? 0) > 0) CombatTimerEngine.start(combat);
  }
  if ("started" in changed && changed.started === false) {
    CombatTimerEngine.stop(); ui.combatTimerHUD?.hide();
    if (game.user.isGM && combat.getFlag?.(MODULE_ID, "startPaused")) combat.unsetFlag(MODULE_ID, "startPaused").catch(()=>{});
    if (game.user.isGM) combat.unsetFlag(MODULE_ID, "state").catch(()=>{});
  }
});

Hooks.on("createCombatant", (combatant) => {
  try {
    const active = game.combats?.active; if (!active) return;
    const parentId = combatant?.combat?.id ?? combatant?.parent?.id ?? null;
    if (parentId && active.id === parentId && active.started && (active.combatants?.size ?? 0) > 0) { CombatTimerEngine.start(active); }
  } catch (err) { console.warn(`[${MODULE_ID}] createCombatant hook failed:`, err); }
});

Hooks.on("deleteCombatant", (combatant) => {
  try {
    const active = game.combats?.active; if (!active) return;
    const parentId = combatant?.combat?.id ?? combatant?.parent?.id ?? null;
    if (parentId && active.id === parentId && (active.combatants?.size ?? 0) === 0) { CombatTimerEngine.stop(); ui.combatTimerHUD?.hide(); }
  } catch (err) { console.warn(`[${MODULE_ID}] deleteCombatant hook failed:`, err); }
});

Hooks.on("deleteCombat", () => { CombatTimerEngine.stop(); ui.combatTimerHUD?.hide(); });

Hooks.on("pauseGame", (paused) => {
  if (paused) CombatTimerEngine.systemPause(); else CombatTimerEngine.systemResume();
});
