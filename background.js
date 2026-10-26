// Moteur de Sidetrack : réglages, état, liaison avec la barre latérale et bouton de la barre
// d'outils. Tourne en arrière-plan pour que la musique continue barre latérale fermée ; la
// barre latérale n'est qu'une télécommande reliée par un port.
//
// Le reste du moteur, chargé dans cet ordre (manifest.json) et partageant ses déclarations :
//   playlists.js   playlists, liens, chapitres, export, mode Playlist
//   player-tab.js  onglet du lecteur et ses messages
//   blind.js       partie de blind test, indices
//   room.js        salon multijoueur (hôte) ; guest.js : le salon de quelqu'un d'autre
//   main.js        commandes de la barre latérale, démarrage
// Aucun fichier n'appelle au chargement une fonction d'un fichier chargé après lui.

// --- Réglages ---------------------------------------------------------------
// Gardés sous « settings » (GUIDE.md) ; chaque valeur reçue de la barre latérale ou lue dans
// le stockage passe par cleanSetting / cleanBlind (type, bornes).

const DEFAULTS = {
  lang: "auto",        // "auto" | "fr" | "en"
  chatSound: false,    // petit son à chaque nouveau message du salon
  showMulti: true,     // bouton 🌐 du salon (désactivable pour un usage solo)
  showPresets: true,   // bouton 📚 des playlists toutes prêtes
  hideTab: true,       // ranger l'onglet du lecteur hors de la barre d'onglets (tabs.hide)
  tabAsked: false,     // choix de ranger l'onglet déjà proposé dans la page du lecteur
  showTips: true,      // bandeau des premiers pas, une fois le lecteur autorisé
  showPreview: false,  // miniature de la vidéo dans le panneau
  nickname: "",        // pseudo dans les salons
  nameSet: false,      // pseudo choisi ou accepté (sinon proposé avant le premier salon)
  volume: 100,
  // startMode : "start" début du morceau | "random" moment aléatoire | "chapter" chapitre aléatoire
  // clip : secondes d'extrait, 0 = morceau entier, -1 = durée du chapitre
  // pause : secondes de réponse affichée avant la manche suivante (0 = on enchaîne à la main)
  // scoring : points de l'animateur, "auto" (comme les joueurs) ou "manual" (il les donne)
  // judge : blind test joué, points « chat » (à l'écrit) ou « self » (chacun se juge)
  // hints : lettres du titre dévoilées peu à peu pendant la manche (le maximum de points baisse)
  blind: { clip: -1, startMode: "chapter", hideVideo: true, pause: 10, scoring: "auto", judge: "chat", hints: true },
  banned: {},          // identité (clé publique) → « Nom · CODE » : refusés dans nos salons
  blocked: {},         // pareil pour les personnes bloquées : cachées dans les salons des autres, refusées dans les nôtres
};

let settings = structuredClone(DEFAULTS);

const int = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);
const bool = (value) => (typeof value === "boolean" ? value : undefined);

function cleanSetting(key, value) {
  switch (key) {
    case "lang":
      return ["auto", "fr", "en"].includes(value) ? value : undefined;
    case "chatSound":
    case "showMulti":
    case "showPresets":
    case "hideTab":
    case "tabAsked":
    case "showTips":
    case "showPreview":
    case "nameSet":
      return bool(value);
    case "nickname":
      return typeof value === "string" ? cleanName(value, "") : undefined;
    case "volume":
      return int(value, 0, 100);
  }
  return undefined;
}

function cleanBlind(key, value) {
  switch (key) {
    case "clip":
      return int(value, -1, 3600);
    case "pause":
      return int(value, 0, 60);
    case "startMode":
      return ["start", "random", "chapter"].includes(value) ? value : undefined;
    case "scoring":
      return ["auto", "manual"].includes(value) ? value : undefined;
    case "judge":
      return ["chat", "self"].includes(value) ? value : undefined;
    case "hideVideo":
    case "hints":
      return bool(value);
  }
  return undefined;
}

// Réglages lus dans le stockage : tout ce qui est invalide reprend sa valeur par défaut
function loadSettings(raw = {}) {
  const out = structuredClone(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const value = cleanSetting(key, raw[key]);
    if (value !== undefined) out[key] = value;
  }
  // Pseudo déjà changé avant l'ajout de nameSet (pas celui proposé, « Invité-1234 ») : choisi
  if (out.nickname && !isProposedName(out.nickname)) out.nameSet = true;
  for (const key of Object.keys(DEFAULTS.blind)) {
    const value = cleanBlind(key, raw.blind?.[key]);
    if (value !== undefined) out.blind[key] = value;
  }
  for (const list of ["banned", "blocked"]) {
    if (!raw[list] || typeof raw[list] !== "object") continue;
    for (const [id, label] of Object.entries(raw[list])) {
      if (/^[0-9a-f]{64}$/.test(id) && typeof label === "string") out[list][id] = cleanText(label, 40);
    }
  }
  return out;
}

// --- État -------------------------------------------------------------------

let state = {
  playlists: [],       // [{ id, name, preset?, items: [{ id, title, chapters? }] }]
  current: null,       // id de la playlist affichée
  index: -1,           // morceau en cours dans la playlist
  shuffle: false,
  mode: "listen",      // "listen" | "blind" | "emcee" (blind test animé par l'hôte d'un salon)
  blindSources: [],    // playlists jouées en blind test (vide : la playlist ouverte)
};

let playerState = -1;  // -1 non démarré, 0 fini, 1 lecture, 2 pause, 5 prête
let loadingSince = 0;  // vidéo demandée au lecteur, pas encore démarrée (indicateur de chargement)
let playerShown = false; // onglet du lecteur affiché (bouton 📺 allumé)
// Position de la vidéo { id, time, duration, playing, at } : la barre latérale la fait avancer
// elle-même, le moteur ne renvoie son état que si la lecture change (pause, saut, autre vidéo)
let position = null;
let importTarget = null;
let notice = null;     // { key, args?, focus? } : traduit par la barre latérale
// Lecteur autorisé : « Sidetrack est prêt » quelques secondes, puis les premiers pas (une fois
// par session, tant qu'on ne les a pas fermés)
let readyShown = false;
let readyTimer = null;
let tips = false;
let tipsShown = false;
const journal = createLog();

// Blind test, joué (« blind ») ou animé par l'hôte d'un salon (« emcee ») : même partie,
// mais l'animateur voit tout (titres, vidéo, propositions) et ne joue pas
function inGame() {
  return state.mode === "blind" || state.mode === "emcee";
}

// Morceau en cours : celui de la partie de blind test, sinon celui de la playlist ouverte
function nowPlaying() {
  return (inGame() && game.track) || items()[state.index] || null;
}

// Partie de blind test en cours (non sauvegardée)
let game = { phase: "idle", tracks: [], track: null, order: [], pos: -1, score: 0, played: 0, remaining: 0 };
let gameTimer = null;

function log(msg) {
  journal.add(msg);
  update();
}

function save() {
  const { playlists, current, shuffle, mode, blindSources } = state;
  browser.storage.local.set({ sidetrack: { playlists, current, shuffle, mode, blindSources }, settings });
}

// --- Identité ----------------------------------------------------------------
// Une clé Nostr gardée en local signe chaque entrée dans un salon (poignée de main de
// common/net.js). Elle s'accompagne d'une preuve de travail (common/pow.js), calculée une
// seule fois, qui donne aussi le code d'identité affiché à côté du nom.

const pow = createPow({ app: "sidetrack", worker: "common/pow-worker.js" });
// Clé et preuve gardées dans browser.storage (« identity », « pow ») ; calcul et reprise : kit
const myIdentity = createIdentity({
  pow,
  read: async () => {
    const stored = await browser.storage.local.get(["identity", "pow"]);
    return { secret: stored.identity, proof: stored.pow };
  },
  write: ({ secret, proof }) => browser.storage.local.set(secret ? { identity: secret } : { pow: proof }),
  onChange: () => update(),
  onReady: (code) => log(t("logIdentityReady", code)),
});
const identity = myIdentity.identity; // { secret, pubkey, pow, code } : rempli par le kit

// --- Liaison avec la barre latérale ---------------------------------------

const ports = new Set();
let updateScheduled = null;

function snapshot() {
  const loading = !!loadingSince && Date.now() - loadingSince < LOADING_MAX;
  const hint = ["playing", "timeup"].includes(game.phase) ? { mask: hintMask(), max: maxPoints() } : null;
  return {
    state, settings, hint, playerState, loading, playerShown, position, notice,
    // La partie sans ses pistes (envoyées une fois dans deck, en blind test seulement)
    game: { ...game, tracks: undefined, track: undefined },
    current: nowPlaying() && { id: nowPlaying().id, title: nowPlaying().title },
    blindSources: blindSources(),
    deck: inGame() ? deck().map(({ id, title, chapters }) => ({ id, title, chapters })) : null, ready: readyShown, tips, log: journal.lines,
    me: { code: identity.code, mining: myIdentity.mining && { percent: powPercent(myIdentity.mining.tries) } },
    room: roomSnapshot(), guest: guestSnapshot(), rooms: publicRoomsSnapshot(),
  };
}

// Regroupe les mises à jour (un import de playlist en déclenche des centaines)
function update() {
  if (updateScheduled) return;
  updateScheduled = setTimeout(() => {
    updateScheduled = null;
    const snap = snapshot();
    for (const port of ports) port.postMessage({ t: "snap", snap });
    roomUpdate();
    syncCover();
  }, 50);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "player") return connectPlayer(port);
  if (port.name !== "sidebar") return;
  ports.add(port);
  clearUnread();
  // Panneau ouvert : l'onglet du lecteur doit exister. Il se prépare tout de suite (écran
  // d'autorisation si Firefox exige un clic), avant même la première vidéo
  warmPlayer();
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async ({ cmd, args = [], req }) => {
    let error = null;
    // Une erreur dans une commande serait sinon invisible : on la met au journal
    try {
      await ready;
      const result = await actions[cmd]?.(...(Array.isArray(args) ? args : []));
      if (typeof result === "string") error = result;
    } catch (e) {
      error = "logCommandError";
      log(t("logCommandError", cmd, e.message));
      console.error(e);
    }
    if (req != null) port.postMessage({ t: "reply", req, error });
  });
  port.postMessage({ t: "snap", snap: snapshot() });
});

// --- Bouton de la barre d'outils ---------------------------------------------
// Un clic ouvre ou ferme la barre latérale. Badge : messages du salon arrivés pendant
// qu'elle était fermée (Sidetrack n'a pas de messages privés).

let unread = 0;

browser.browserAction.onClicked.addListener(() => browser.sidebarAction.toggle());

function noteMessage() {
  if (ports.size) return;
  unread++;
  browser.browserAction.setBadgeBackgroundColor({ color: BADGE_COLORS.COUNT });
  browser.browserAction.setBadgeText({ text: countText(unread, 99) });
}

function clearUnread() {
  unread = 0;
  browser.browserAction.setBadgeText({ text: "" });
}

function showReady() {
  readyShown = true;
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    readyShown = false;
    update();
  }, 5000);
}

function startTips() {
  if (tipsShown || !settings.showTips) return;
  tipsShown = true;
  tips = true;
}

// Changer de mode ne coupe pas la musique : seul « Démarrer la partie » lance le blind test.
function setMode(mode) {
  if (!["listen", "blind", "emcee"].includes(mode)) return;
  if (state.mode === mode || (mode === "emcee" && !room)) return;
  const wasGame = inGame();
  state.mode = mode;
  // Passer du blind test joué au blind test animé garde la partie en cours
  if (!(wasGame && inGame())) resetGame();
  if (mode === "blind") hidePlayerTab(); // on joue : la vidéo ne doit pas rester sous les yeux
  update();
  save();
}
