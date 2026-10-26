// Onglet Blind test du panneau (et Animateur) : playlists jouées, réglages, partie en cours,
// réponses, liste des pistes de l'animateur.

$("#clip").addEventListener("change", (e) => act("setBlind", "clip", Number(e.target.value)));
$("#startMode").addEventListener("change", (e) => act("setBlind", "startMode", e.target.value));
$("#hideVideo").addEventListener("change", (e) => act("setBlind", "hideVideo", e.target.checked));
$("#hints").addEventListener("change", (e) => act("setBlind", "hints", e.target.checked));
$("#pause").addEventListener("change", (e) => act("setBlind", "pause", Number(e.target.value)));
$("#scoring").addEventListener("change", (e) => act("setBlind", "scoring", e.target.value));
$("#judge").addEventListener("change", (e) => act("setBlind", "judge", e.target.value));
$("#rounds").addEventListener("change", (e) => act("setBlind", "rounds", Number(e.target.value)));
$("#fresh").addEventListener("change", (e) => act("setBlind", "fresh", e.target.checked));
for (const b of document.querySelectorAll("#formulas button")) {
  b.addEventListener("click", () => act("applyFormula", b.dataset.formula));
}

// Raccourcis (onglet Blind test, hors d'un champ) : Espace révèle puis passe à la manche
// suivante, R réécoute l'extrait
document.addEventListener("keydown", (e) => {
  if (!view || view.guest || shownTab === "listen" || $("#main").hidden) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.target.closest?.("input, select, textarea")) return;
  const { game } = view;
  if (e.key === " ") {
    e.preventDefault();
    if (["playing", "timeup"].includes(game.phase)) act("reveal");
    else if (game.phase === "revealed" && !waitsForClaim()) act("nextRound");
  } else if (e.key === "r" || e.key === "R") {
    act("replayClip");
  }
});

// Seul et juge de soi-même : la manche attend « Trouvé » ou « Raté »
function waitsForClaim() {
  return !view.room && view.state.mode === "blind" && view.settings.blind.judge === "self" && !view.game.answered;
}
$("#guess-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#guess-input").value.trim();
  if (!text) return;
  act("soloGuess", text);
  $("#guess-input").value = "";
});

// Indice façon pendu (joueurs seulement : l'animateur voit le titre)
function renderHint(hint) {
  $("#hint").hidden = !hint?.mask;
  if (!hint?.mask) return;
  $("#hint-mask").textContent = hint.mask;
  $("#hint-max").textContent = t("hintMax", hint.max);
}

// multi : animateur (il arbitre) ; room : dans un salon, qu'on anime ou qu'on joue
function renderBlind(game, n, multi, room = multi) {
  const status = $("#blind-status");
  const blind = view.settings.blind;
  const self = !multi && blind.judge === "self"; // chacun se juge (Trouvé / Raté)
  const total = game.order.length;
  // Score « x/y » en solo seulement : dans un salon, les points s'affichent sur les pastilles
  const round = room
    ? t("round", game.pos + 1, total)
    : `${t("round", game.pos + 1, total)} · ${t("score", game.score, game.played)}`;
  const how = multi ? (blind.scoring === "manual" ? t("givePoints") : t("autoPoints")) : room ? t(self ? "selfPoints" : "autoPoints") : "";
  const next = game.nextIn ? ` · ${t("nextIn", game.nextIn)}` : "";
  status.textContent = {
    idle: n ? t("tracks", n) : t("emptyShort"),
    loading: t("loadingChapters"),
    playing: round,
    timeup: `${round} · ${t("timeUpBang")}`,
    revealed: `${round}${how ? ` · ${how}` : ""}${next}`,
    over: t("gameOver"),
  }[game.phase];
  if (game.phase === "over" && !room) {
    status.append(" : ");
    status.appendChild(el("strong", { textContent: `${game.score}/${game.played}` }));
  }
  renderRecap(game);
  $("#blind-actions").replaceChildren(...(multi ? emceeControls(game, n) : playerActions(game, n, room, self)));

  // Seul, points à l'écrit : champ de réponse et réponses de la manche
  const writing = !room && !self && ["playing", "timeup", "revealed"].includes(game.phase);
  $("#solo-guess").hidden = !writing;
  if (writing) {
    $("#guess-list").replaceChildren(...game.guesses.map((g) => el("li", { textContent: `🔒 ${g.text}` })));
    if (game.phase === "revealed") $("#guess-list").appendChild(el("li", { textContent: t("soloPoints", game.lastPoints), className: "points" }));
    $("#guess-input").disabled = game.phase === "revealed";
  }

  // Entre deux parties : les playlists jouées et les réglages (l'animateur garde les réglages)
  const between = ["idle", "over"].includes(game.phase);
  $("#blind-setup").hidden = !multi && !between;
  $("#blind-pick").hidden = !between;
  if (between) renderSources();
  renderSummary();
  $("#hideVideo-label").textContent = t(room ? "hideVideoGuests" : "hideVideo");
  $("#judge-row").hidden = multi;
  $("#scoring-row").hidden = !multi;
}

// Playlists jouées : une case par playlist (sans case cochée, la playlist ouverte)
function renderSources() {
  const chosen = new Set(view.blindSources);
  const lists = view.state.playlists;
  if (!changed("sources", [...chosen], lists.map((p) => `${p.id}|${p.name}|${p.items.length}`))) return;
  $("#blind-sources").replaceChildren(
    ...lists.map((p) => {
      const box = el("input", { type: "checkbox", checked: chosen.has(p.id) });
      box.addEventListener("change", () =>
        act("setBlindSources", lists.filter((q) => (q.id === p.id ? box.checked : chosen.has(q.id))).map((q) => q.id))
      );
      const label = el("label", {}, box, el("span", { textContent: p.name, className: "name" }), el("span", { textContent: String(p.items.length), className: "muted" }));
      label.title = p.name;
      return el("li", {}, label);
    })
  );
}

// Réglages de la partie repliés en une ligne : « ⚙ 20 s · chapitre aléatoire · indices · pause 10 s »
function renderSummary() {
  const b = view.settings.blind;
  const label = (id, value) => $(id).querySelector(`option[value="${value}"]`)?.textContent ?? "";
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const parts = [label("#clip", b.clip), lower(label("#startMode", b.startMode))];
  if (b.rounds) parts.unshift(t("roundsShort", b.rounds));
  if (b.hints) parts.push(t("hintsShort"));
  if (b.pause) parts.push(t("pauseShort", b.pause));
  $("#blind-summary").textContent = `⚙ ${parts.join(" · ")}`;
  $("#blind-summary").title = t("blindOptionsTitle");
}

// Animateur : quatre boutons comme en mode Playlist, la liste des pistes en dessous
function emceeControls(game, n) {
  const live = ["playing", "timeup"].includes(game.phase);
  const b = (text, title, cmd, enabled) => {
    const x = button(text, () => act(cmd));
    x.title = t(title);
    x.disabled = !enabled;
    return x;
  };
  return [
    b("🔀", "newGameTitle", "startGame", n > 0 && game.phase !== "loading"),
    b(view.playerState === 1 ? "⏸" : "▶", "playPause", "playPause", !["idle", "over", "loading"].includes(game.phase)),
    b("👁", "revealTitle", "reveal", live),
    b("↺", "replayTitle", "replayClip", live),
    b("⏭", "nextRoundTitle", "nextRound", live || game.phase === "revealed"),
  ];
}

// On joue : démarrer, révéler, passer ; à la révélation, se juger ou passer à la suite
function playerActions(game, n, room, self) {
  switch (game.phase) {
    case "idle": {
      const start = button(t("startGame"), () => act("startGame"));
      start.disabled = !n;
      return [start];
    }
    case "playing":
    case "timeup": {
      const reveal = button(t("reveal"), () => act("reveal"));
      reveal.title = t("revealKeyTitle");
      const again = button(t("replayClip"), () => act("replayClip"));
      again.title = t("replayTitle");
      const skip = button(t("skip"), () => act("nextRound"));
      const stop = button("■", () => act("stopGame"));
      stop.title = t("stopGame");
      return game.phase === "playing" ? [reveal, again, skip, stop] : [reveal, again, stop];
    }
    case "revealed": {
      const nextBtn = button(t("nextRound"), () => act("nextRound"));
      nextBtn.title = t("nextKeyTitle");
      if (!self) return [nextBtn];
      const done = room ? !!view.room.hostClaimed : !!game.answered;
      const found = button(t("found"), () => act("claim", true), "good");
      const missed = button(t("missed"), () => act("claim", false), "bad");
      found.disabled = missed.disabled = done;
      return room ? [found, missed, nextBtn] : [found, missed];
    }
    case "over":
      return [button(t("replay"), () => act("startGame"))];
    case "loading": {
      const stop = button(`■ ${t("stopGame")}`, () => act("stopGame"));
      return [stop];
    }
    default:
      return [];
  }
}

// Animateur : il voit les pistes et choisit la prochaine manche
let hostTracksShown = true;
$("#host-tracks-toggle").addEventListener("click", () => {
  hostTracksShown = !hostTracksShown;
  render();
});

function renderHostTracks(game) {
  const played = new Set(game.order.slice(0, game.pos + 1).map(({ i, chapter }) => (chapter == null ? `${i}` : `${i}:${chapter}`)));
  const list = view.deck ?? [];
  const index = game.pos >= 0 ? game.order[game.pos]?.i ?? -1 : -1;
  $("#host-tracks-title").textContent = t("tracksTitle", list.length);
  $("#host-tracks-toggle").textContent = hostTracksShown ? t("hide") : t("show");
  $("#host-queue").hidden = !hostTracksShown;
  if (hostTracksShown && changed("host", index, [...played], itemsKey(list))) {
    $("#host-queue").replaceChildren(...trackList(index, { list, picking: true, played }));
  }
}

// Réglages de la partie (sauf le champ en cours de modification)
function renderBlindForm(blind, referee) {
  const set = (id, value) => document.activeElement !== $(id) && ($(id).value = String(value));
  $("#clip").querySelector('option[value="-1"]').disabled = blind.startMode !== "chapter";
  set("#clip", blind.clip);
  set("#startMode", blind.startMode);
  $("#hideVideo").checked = blind.hideVideo;
  $("#hints").checked = blind.hints;
  set("#pause", blind.pause);
  set("#scoring", blind.scoring);
  set("#judge", blind.judge);
  set("#rounds", blind.rounds);
  $("#fresh").checked = blind.fresh;
  for (const o of $("#pause").options) if (o.value !== "0") o.textContent = t("pauseAfter", o.value);
  $("#scoring-row").hidden = !referee;
  // Réglage tout fait qui correspond aux réglages actuels : allumé
  for (const b of document.querySelectorAll("#formulas button")) {
    const f = view.formulas[b.dataset.formula];
    b.classList.toggle("on", Object.keys(f).every((k) => blind[k] === f[k]));
  }
}

// Fin de partie : les manches jouées (réponse, résultat), un clic pour réécouter
function renderRecap(game) {
  const shown = game.phase === "over" && game.history.length > 0;
  $("#recap").hidden = !shown;
  if (!shown || !changed("recap", game.history)) return;
  $("#recap-list").replaceChildren(
    ...game.history.map((h, k) => {
      const row = el("div", { className: "row" });
      const result = h.points != null ? `+${h.points}` : h.found === true ? "✓" : h.found === false ? "✗" : "";
      if (result) row.appendChild(el("b", { textContent: result, className: h.points > 0 || h.found ? "good" : "bad" }));
      row.appendChild(el("span", { textContent: h.title })).title = h.title;
      row.addEventListener("click", () => act("blindReplay", k));
      return el("li", {}, row);
    })
  );
}
