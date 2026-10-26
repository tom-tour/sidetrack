// Commandes de la barre latérale et démarrage du moteur. Chargé en dernier : les commandes
// peuvent nommer directement les fonctions de tous les autres fichiers du moteur.

// --- Commandes de la barre latérale ----------------------------------------

const actions = {
  selectPlaylist,
  createPlaylist: (name) => selectPlaylist(newPlaylist(cleanText(name, 80) || t("defaultPlaylist")).id),
  renamePlaylist: (name) => {
    name = cleanText(name, 80);
    if (playlist() && name) playlist().name = name;
    update();
    save();
  },
  deletePlaylist,
  addPreset,
  restorePlaylists,
  logBackup: (count, file) => log(t("logBackup", Number(count) || 0, cleanText(file, 80))),
  addLink,
  removeItem,
  moveItem,
  loadChapters,
  play: (i) => play(i),
  playAt: (i, start) => play(i, { start: Math.max(0, Number(start) || 0) }),
  seek: (time) => send({ action: "seek", time: Math.max(0, Number(time) || 0) }),
  // Clic de l'hôte sur une vidéo, un chapitre ou un moment proposé dans le chat :
  // lance la vidéo à cet instant pour tout le salon
  playRef: (ref) => {
    const i = items().findIndex((item) => item.id === ref?.id);
    if (i < 0) return log(t("logNotInPlaylist"));
    const start = Math.max(0, Number(ref.start) || 0);
    if (i === state.index && playerPort) send({ action: "seek", time: start });
    else play(i, { start });
  },
  // Salon (room.js) et salon de quelqu'un d'autre (guest.js)
  openRoom: (options) => openRoom(options),
  refreshPublicRooms: () => refreshPublicRooms(),
  closeRoom: () => closeRoom(),
  joinRoom: (code) => joinRoom(code),
  leaveRoom: () => leaveRoom(),
  guestChat: (text, secret) => guestChat(text, secret),
  guestRef: (ref) => guestRef(ref),
  guestClaim: (found) => guestSend({ t: "claim", found: found === true }),
  shareMoment: () => shareMoment(),
  hostChat: (text, secret) => hostChat(text, null, secret),
  award: (playerId, delta) => award(playerId, delta === -1 ? -1 : 1),
  kick: (playerId) => kick(playerId, false),
  ban: (playerId) => kick(playerId, true),
  unban: (playerId) => {
    delete settings.banned[playerId];
    room?.kicked.delete(playerId); // bannir excluait aussi du salon ouvert : il peut y revenir
    update();
    save();
  },
  // Bloquer : choix personnel, depuis la fiche d'une personne dans le salon de quelqu'un d'autre
  block: (playerId) => guestBlock(playerId),
  unblock: (playerId) => {
    delete settings.blocked[playerId];
    guestUnblock(playerId);
    update();
    save();
  },
  next,
  prev,
  toggle,
  // Blind test : lecture ou pause du morceau de la manche, sans toucher à la partie
  playPause: () => send({ action: playerState === 1 ? "pause" : "play" }),
  toggleShuffle: () => {
    state.shuffle = !state.shuffle;
    update();
    save();
  },
  setMode,
  startGame,
  // Blind test solo, points à l'écrit : nos réponses de la manche, la meilleure compte
  soloGuess: (text) => {
    text = cleanText(text, 120);
    if (!text || room || !["playing", "timeup"].includes(game.phase) || game.guesses.length >= 30) return;
    game.guesses.push({ text, max: maxPoints() });
    update();
  },
  // « Trouvé / Raté » : seul, on compte sa manche ; dans un salon, on se donne son point
  claim: (found) => (room ? claim("host", found === true) : answer(found === true)),
  nextRound,
  blindPick,
  setBlindSources,
  applyFormula,
  replayClip,
  stopGame,
  blindReplay,
  reveal,
  answer,
  setBlind: (key, value) => {
    const clean = cleanBlind(key, value);
    if (clean === undefined) return;
    settings.blind[key] = clean;
    // « Durée du chapitre » n'a de sens qu'avec un départ par chapitre
    if (key === "startMode" && clean !== "chapter" && settings.blind.clip === -1) settings.blind.clip = 20;
    update();
    save();
  },
  exportPlaylist,
  focusPlayer: () => focusPlayer(false),
  togglePlayerTab: () => focusPlayer(true),
  setVolume: (value) => {
    const clean = cleanSetting("volume", value);
    if (clean === undefined) return;
    settings.volume = clean;
    send({ action: "volume", value: clean });
    update();
    save();
  },
  setSetting: (key, value) => {
    if (!["lang", "showMulti", "chatSound", "nickname", "nameSet", "hideTab", "showPresets", "showTips", "showPreview"].includes(key)) return;
    const clean = cleanSetting(key, value);
    if (clean === undefined) return;
    settings[key] = clean;
    if (key === "nickname") {
      settings.nameSet = true;
      if (!clean) settings.nickname = proposedName(); // champ vidé : un nouveau pseudo proposé
    }
    if (key === "hideTab") applyHideTab();
    if (key === "showTips") tips = clean; // case recochée : les conseils reviennent tout de suite
    if (key === "lang") setLang(clean);
    update();
    save();
  },
  dismissNotice: () => {
    notice = null;
    update();
  },
  dismissReady: () => {
    clearTimeout(readyTimer);
    readyShown = false;
    update();
  },
  // OK : fermé pour la session ; Ne plus afficher : réglage showTips décoché
  dismissTips: (forever) => {
    tips = false;
    if (forever === true) {
      settings.showTips = false;
      save();
    }
    update();
  },
};

// --- Démarrage -------------------------------------------------------------

async function init() {
  const stored = await browser.storage.local.get(["sidetrack", "settings", "identity", "pow"]);
  const data = stored.sidetrack ?? {};
  // Avant le kit commun, les réglages étaient rangés avec les playlists : on les reprend
  settings = loadSettings(stored.settings ?? data);
  if (Array.isArray(data.playlists)) state.playlists = data.playlists;
  if (typeof data.current === "string") state.current = data.current;
  state.shuffle = data.shuffle === true;
  state.mode = data.mode === "blind" ? "blind" : "listen"; // pas de salon au démarrage
  if (Array.isArray(data.blindSources)) state.blindSources = data.blindSources.filter((id) => typeof id === "string");
  if (Array.isArray(data.blindPlayed)) state.blindPlayed = data.blindPlayed.filter((k) => typeof k === "string").slice(-PLAYED_MAX);
  setLang(settings.lang);
  if (!settings.nickname) settings.nickname = proposedName();
  if (!state.playlists.length) newPlaylist(t("defaultPlaylist"));
  if (!playlist()) state.current = state.playlists[0].id;
  state.index = -1;
  save();
  update();
  await myIdentity.load();
  update();
}

const ready = init();
