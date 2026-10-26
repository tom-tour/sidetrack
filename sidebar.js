// Télécommande : tout le moteur tourne en arrière-plan (background.js et ses fichiers).
// On envoie des commandes par le port et on affiche l'instantané qu'il renvoie.
//
// Ce fichier : liaison avec le moteur, réglages, bandeaux, lecteur commun aux onglets (aperçu,
// progression, volume) et affichage. Puis, dans cet ordre (sidebar.html) :
//   sidebar-playlist.js  onglet Playlist (playlists, lien, file de lecture)
//   sidebar-blind.js     onglet Blind test (playlists jouées, réglages, partie, animateur)
//   sidebar-room.js      salon : création, chat, fiches, et le salon de quelqu'un d'autre

const $ = (s) => document.querySelector(s);

const port = browser.runtime.connect({ name: "sidebar" });
let view = null; // dernier instantané du moteur : { state, settings, game, me, room, guest, rooms… }

function act(cmd, ...args) {
  port.postMessage({ cmd, args });
}

// Commande dont on attend la réponse : → clé d'erreur, ou null
let reqSeq = 0;
const replies = new Map();
function ask(cmd, ...args) {
  const req = ++reqSeq;
  port.postMessage({ cmd, args, req });
  return new Promise((resolve) => replies.set(req, resolve));
}

let translated = false;
port.onMessage.addListener((msg) => {
  if (msg.t === "reply") {
    replies.get(msg.req)?.(msg.error);
    replies.delete(msg.req);
    return;
  }
  if (msg.t !== "snap") return;
  view = msg.snap;
  // Langue : traduction des textes fixes au premier état reçu, puis à chaque changement
  if (setLang(view.settings.lang) || !translated) {
    translated = true;
    applyI18n();
  }
  render();
});

$("#version").textContent = browser.runtime.getManifest().version;

function items() {
  const { playlists, current } = view.state;
  return playlists.find((p) => p.id === current)?.items ?? [];
}

// --- Réglages --------------------------------------------------------------

const SETTING_BOXES = ["chatSound", "showPresets", "showTips", "showPreview", "hideTab", "showMulti"];

function showSettings(open) {
  $("#main").hidden = open;
  $("#settings").hidden = !open;
}

$("#open-settings").addEventListener("click", () => showSettings(true));
$("#close-settings").addEventListener("click", () => showSettings(false));
$("#set-lang").addEventListener("change", (e) => act("setSetting", "lang", e.target.value));
for (const key of SETTING_BOXES) {
  $(`#set-${key}`).addEventListener("change", (e) => act("setSetting", key, e.target.checked));
}
$("#set-nickname").addEventListener("change", (e) => act("setSetting", "nickname", e.target.value));

// Sauvegarde : un fichier JSON avec toutes les playlists, téléchargé depuis le panneau
$("#backup-save").addEventListener("click", () => {
  const backup = {
    app: "sidetrack",
    version: 1,
    saved: new Date().toISOString(),
    playlists: view.state.playlists.map(({ id, name, preset, items }) => ({ id, name, preset, items })),
  };
  const name = `sidetrack-playlists-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  act("logBackup", backup.playlists.length, name);
});

// Restauration : le moteur vérifie le contenu du fichier avant de l'ajouter
$("#backup-restore").addEventListener("click", () => $("#backup-file").click());
$("#backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    // pas du JSON : le moteur le signalera comme fichier invalide
  }
  act("restorePlaylists", data);
});

// --- Lecteur : 📺, aperçu, volume ; onglets des modes ----------------------

$("#show-player").addEventListener("click", () => act("togglePlayerTab"));
// L'aperçu fait comme 📺 (sauf quand 📺 est caché : blind test joué)
$("#art").addEventListener("click", () => !$("#show-player").hidden && act("togglePlayerTab"));
$("#volume").addEventListener("input", (e) => act("setVolume", Number(e.target.value)));
// Onglets. Pendant une partie de blind test, aller voir les playlists ne l'arrête pas :
// l'onglet Playlist s'affiche ici seulement (tab), la partie continue, et un bandeau propose
// d'y revenir ou de l'arrêter. Sans partie en cours, l'onglet change le mode du moteur.
let tab = null;      // onglet affiché quand il diffère du mode du moteur (partie en cours)
let shownTab = "listen";
let gameLocked = false; // partie en cours : rien ne se lance depuis l'onglet Playlist

function chooseTab(mode) {
  tab = gameLocked && mode === "listen" ? "listen" : null;
  if (!tab) act("setMode", mode);
  render();
}
$("#mode-listen").addEventListener("click", () => chooseTab("listen"));
$("#mode-blind").addEventListener("click", () => chooseTab("blind"));
$("#mode-emcee").addEventListener("click", () => chooseTab("emcee"));

// Ligne de progression : extrait d'une manche (clip), sinon la vidéo en cours (videoId), dont
// la position avance ici entre deux états du moteur. seek : un clic sur la barre y amène.
let progress = null; // { clip?, phase?, remaining?, videoId?, seek }

function renderProgress() {
  const box = $("#progress");
  const bar = $("#pos-bar");
  let time = 0;
  let total = 0;
  if (progress?.clip > 0) {
    total = progress.clip;
    time = progress.phase === "timeup" ? total : Math.max(0, total - progress.remaining);
  } else {
    const p = view?.position;
    if (progress?.videoId && p?.id === progress.videoId && p.duration > 0) {
      total = p.duration;
      time = Math.min(total, p.time + (p.playing ? (Date.now() - p.at) / 1000 : 0));
    }
  }
  box.hidden = !total;
  box.classList.toggle("seek", !!progress?.seek && !progress.clip);
  if (!total) return;
  bar.max = total;
  bar.value = time;
  $("#pos-time").textContent = formatTime(time);
  $("#pos-total").textContent = formatTime(total);
}
setInterval(() => view?.position?.playing && !progress?.clip && renderProgress(), 500);

$("#pos-bar").addEventListener("click", (e) => {
  if (!progress?.seek || progress.clip || !(view.position?.duration > 0)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  if (!rect.width) return;
  act("seek", Math.floor(((e.clientX - rect.left) / rect.width) * view.position.duration));
});

// --- Éléments d'interface ------------------------------------------------------
// el, button, swatch, codeTag, chip, personCard, peopleList : common/ui.js

function formatTime(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function renderNotice() {
  const box = $("#notice");
  box.hidden = !view.notice;
  if (!view.notice) return;
  const actions = el("div", { className: "actions" });
  // Un clic à faire dans l'onglet : pas de OK, le bandeau part quand c'est fait
  if (view.notice.focus) actions.appendChild(button(t("goToTab"), () => act("focusPlayer")));
  else actions.appendChild(button(t("ok"), () => act("dismissNotice")));
  box.replaceChildren(t(view.notice.key, ...(view.notice.args ?? [])), actions);
}

$("#ready-ok").addEventListener("click", () => act("dismissReady"));
$("#tips-ok").addEventListener("click", () => act("dismissTips", false));
$("#tips-never").addEventListener("click", () => act("dismissTips", true));

// Premiers pas : les trois choses à essayer pulsent tant que le bandeau est ouvert
function renderTips() {
  $("#ready").hidden = !view.ready;
  const shown = !!view.tips && !view.guest;
  $("#tips").hidden = !shown;
  const presets = view.settings.showPresets;
  const room = !$("#toggle-room").hidden;
  $("#tip-presets").hidden = !presets;
  $("#tip-room").hidden = !room;
  $("#url").classList.toggle("beckon", shown);
  $("#pl-presets").classList.toggle("beckon", shown && presets);
  $("#toggle-room").classList.toggle("beckon", shown && room);
}

// File de lecture : glisser-déposer pour réordonner, ▸ pour dérouler les chapitres
const expanded = new Set();      // ids des vidéos dépliées
const chaptersAsked = new Set(); // ids dont on a demandé les chapitres
let dragging = false;

// Une liste de pistes. Mode Playlist : glisser-déposer, suppression, clic = lecture.
// Animateur : pistes de la partie, clic = prochaine manche, pistes déjà jouées grisées,
// rien d'éditable.
function trackList(index, { list = items(), picking = false, played = new Set() } = {}) {
  return list.map((item, i) => {
    const li = el("li", { className: i === index ? (view.loading ? "current loading" : "current") : played.has(`${i}`) ? "played" : "" });
    li.draggable = !picking;
    li.addEventListener("dragstart", (e) => {
      dragging = true;
      e.dataTransfer.setData("text/plain", String(i));
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      dragging = false;
      render();
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      li.classList.add("drop-target");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      dragging = false;
      act("moveItem", Number(e.dataTransfer.getData("text/plain")), i);
    });

    const row = li.appendChild(el("div", { className: "row" }));
    const open = expanded.has(item.id);
    row.appendChild(
      button(open ? "▾" : "▸", (e) => {
        e.stopPropagation();
        if (open) expanded.delete(item.id);
        else expanded.add(item.id);
        render();
      })
    ).title = t("chapters");
    const title = row.appendChild(el("span", { textContent: item.title }));
    title.title = item.title;
    row.addEventListener("click", () => (picking || !gameLocked) && act(picking ? "blindPick" : "play", i, null));
    if (!picking) {
      const del = row.appendChild(
        button("✕", (e) => {
          e.stopPropagation();
          act("removeItem", i);
        }, "del")
      );
      del.title = t("removeItem");
    }

    if (open) {
      const list = li.appendChild(el("ul", { className: "chapters" }));
      if (!Array.isArray(item.chapters)) {
        list.appendChild(el("li", { textContent: t("loadingChapters"), className: "muted" }));
        if (!chaptersAsked.has(item.id)) {
          chaptersAsked.add(item.id);
          act("loadChapters", item.id);
        }
      } else if (!item.chapters.length) {
        list.appendChild(el("li", { textContent: t("noChapters"), className: "muted" }));
      } else {
        item.chapters.forEach((c, k) => {
          const cli = list.appendChild(el("li", { className: played.has(`${i}:${k}`) ? "played" : "" }));
          const crow = cli.appendChild(el("div", { className: "row" }));
          crow.append(el("time", { textContent: formatTime(c.start) }), el("span", { textContent: c.title }));
          crow.title = c.title;
          crow.addEventListener("click", () => (picking ? act("blindPick", i, k) : act("playAt", i, c.start)));
        });
      }
    }
    return li;
  });
}

// Pendant une partie, le moteur renvoie son état chaque seconde : une liste n'est reconstruite
// que si ce qu'elle affiche a changé (et un clic en cours sur une ligne n'est pas perdu)
const drawn = new Map();
function changed(list, ...parts) {
  const key = JSON.stringify([document.documentElement.lang, [...expanded], view.loading, ...parts]);
  if (drawn.get(list) === key) return false;
  drawn.set(list, key);
  return true;
}
const itemsKey = (list) => list.map((it) => `${it.id}|${it.title}|${Array.isArray(it.chapters) ? it.chapters.length : "-"}`);

// --- Affichage -------------------------------------------------------------

function render() {
  if (!view) return;
  const { state, settings, game } = view;
  const multi = !!view.room;
  // Animateur (hôte d'un salon, onglet 🎤) : il voit tout. Sinon, en blind test, on joue.
  const referee = multi && state.mode === "emcee";

  renderPlaylistBar(state);
  renderNotice();
  renderPresets();

  const blind = state.mode === "blind" || state.mode === "emcee";
  // On joue (seul, ou avec ses invités) : rien n'est dévoilé pendant la manche
  const secret = blind && !referee && ["playing", "timeup"].includes(game.phase);
  gameLocked = blind && !["idle", "over"].includes(game.phase);
  if (!gameLocked) tab = null;
  shownTab = tab ?? state.mode;
  const blindTab = shownTab !== "listen"; // onglet affiché : Blind test ou Animateur
  $("#mode-listen").classList.toggle("on", shownTab === "listen");
  $("#mode-blind").classList.toggle("on", shownTab === "blind");
  $("#mode-emcee").classList.toggle("on", shownTab === "emcee");
  $("#mode-emcee").hidden = !multi;
  renderRoom(blind);
  renderTips();
  renderSettings(settings);

  // Invité d'un salon : pas de playlist à soi ni de blind test, on suit l'hôte
  const guest = view.guest;
  // Chaque onglet a son haut de page : playlists et lien, ou playlists jouées et réglages
  $("#listen-head").hidden = !!guest || blindTab;
  if (guest || !blindTab) $("#blind-setup").hidden = true;
  $("#tabs").hidden = !!guest;
  $("#guest").hidden = !guest;
  $("#listen").hidden = !!guest || blindTab;
  $("#blind").hidden = !!guest || !blindTab;
  if (document.activeElement !== $("#volume")) $("#volume").value = String(settings.volume);
  if (guest) return renderGuest(guest);

  // Miniature du morceau (la vidéo est dans l'onglet masqué). En blind test joué, aperçu noir
  // sauf une fois la réponse révélée (ou pendant la manche si on ne masque pas la vidéo).
  const current = view.current;
  const preview = settings.showPreview;
  $("#player-wrap").hidden = !preview;
  const art = $("#art");
  const showArt = current && (!blind || referee || game.phase === "revealed" || (secret && !settings.blind.hideVideo));
  art.hidden = !showArt;
  if (showArt) {
    const src = `https://i.ytimg.com/vi/${current.id}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = blind && !referee;
  art.classList.toggle("still", $("#show-player").hidden);
  $("#mask").hidden = !(secret && settings.blind.hideVideo);
  const clipTime = game.phase === "timeup" ? t("timeUp") : game.clip ? formatTime(game.remaining) : "";
  $("#mask-time").textContent = clipTime;
  // Pendant une manche : le temps de l'extrait. Sinon la vidéo, où un clic sur la barre amène
  // (pour tout le salon), sauf pendant une manche jouée.
  progress =
    blind && ["playing", "timeup"].includes(game.phase) && game.clip > 0
      ? { clip: game.clip, phase: game.phase, remaining: game.remaining }
      : { videoId: current?.id, seek: !secret };
  renderProgress();
  // Une fois révélé (ou pour l'arbitre), en partie par chapitres, la réponse est le titre du chapitre
  const answer =
    blind && (referee || game.phase === "revealed") && game.chapter?.title
      ? `${game.chapter.title} · ${current?.title ?? ""}`
      : current?.title;
  const timer = blind && referee && game.phase === "playing" && game.clip ? ` · ${formatTime(game.remaining)}` : "";
  $("#now").textContent = secret
    ? t("mystery") + (!preview && clipTime ? ` · ${clipTime}` : "")
    : (answer ?? t("nothingPlaying")) + timer;
  $("#now").classList.toggle("loading", !preview && !!view.loading);

  $("#toggle").textContent = view.playerState === 1 ? "⏸" : "▶";
  $("#loading").hidden = !view.loading;
  $("#show-player").classList.toggle("on", !!view.playerShown);

  renderBlindForm(settings.blind, referee);
  renderHint(secret ? view.hint : null);

  $("#host-tracks").hidden = !referee;
  if (referee) renderHostTracks(game);
  if (blindTab) renderBlind(game, view.deck?.length ?? 0, referee, multi);
  else {
    renderGameBanner(game);
    renderQueue(state.index);
  }
}

function renderSettings(settings) {
  $("#set-lang").value = settings.lang;
  for (const key of SETTING_BOXES) $(`#set-${key}`).checked = settings[key];
  if (document.activeElement !== $("#set-nickname")) $("#set-nickname").value = settings.nickname;
  $("#set-nickname").placeholder = t("defaultName");
  $("#my-code").textContent = view.me.code || "…";
  // Personnes bloquées puis bannies, au format « Nom · CODE »
  $("#blocked").replaceChildren(
    ...peopleList(Object.entries(settings.blocked), { empty: t("noBlocked"), action: t("unblock"), onAction: (id) => act("unblock", id) })
  );
  $("#banned").replaceChildren(
    ...peopleList(Object.entries(settings.banned), { empty: t("noBanned"), action: t("unban"), onAction: (id) => act("unban", id) })
  );
  $("#log").textContent = view.log.join("\n");
}
