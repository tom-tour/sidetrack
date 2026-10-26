// Onglet du lecteur. Fait partie du moteur (voir background.js).
//
// Le lecteur vit dans un onglet masqué : Firefox n'autorise le son que dans une page
// qui a reçu un clic, ce qui est impossible pour un lecteur caché en arrière-plan.
// L'onglet s'affiche le temps de ce clic, puis disparaît de la barre d'onglets.

// Page du lecteur (dossier player/), hébergée sur GitHub Pages.
const PLAYER_URL = "https://tom-tour.github.io/sidetrack/player/index.html";

// --- Lecteur ---------------------------------------------------------------

const STATE_NAMES = { "-1": "stateUnstarted", 0: "stateEnded", 1: "statePlaying", 2: "statePaused", 3: "stateBuffering", 5: "stateCued" };

let playerPort = null;
let playerTabId = null;
let queued = [];
let opening = null;

const LOADING_MAX = 30000; // au-delà, l'indicateur de chargement s'efface de lui-même

function send(cmd) {
  if (cmd.action === "load") {
    loadingSince = Date.now();
    setTimeout(update, LOADING_MAX + 100);
    syncCover(); // cache posé avant que la vidéo n'apparaisse
  }
  if (playerPort) return playerPort.postMessage(cmd);
  // Sans onglet, seul un chargement justifie d'en ouvrir un
  if (cmd.action !== "load" && cmd.action !== "playlist") return;
  queued.push(cmd);
  openPlayerTab();
}

let returnTabId = null;
let warmup = false;      // onglet ouvert d'avance, sans vidéo : on revient dès qu'il est prêt
let coverShown = null;   // dernier état du cache envoyé à la page du lecteur
let returnAfterStart = null; // retour à la navigation différé jusqu'au démarrage de la vidéo

// Ouvre un onglet neuf pour le lecteur, en fermant un éventuel ancien onglet déconnecté.
// Il passe au premier plan : Firefox ne lance aucun média dans un onglet jamais affiché.
async function openPlayerTab() {
  if (opening) return;
  opening = setTimeout(() => (opening = null), 10000);
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  returnTabId = active?.id ?? null;
  const [tab] = await browser.tabs.query({ url: "https://tom-tour.github.io/sidetrack/player/*" });
  if (tab) await browser.tabs.remove(tab.id);
  // Paramètre anti-cache : GitHub Pages garde les fichiers jusqu'à 10 minutes
  browser.tabs.create({ url: `${PLAYER_URL}?t=${Date.now()}`, active: true });
}

// Revient à l'onglet où l'on naviguait avant l'ouverture du lecteur
// (l'onglet du lecteur se masque alors via onActivated)
async function backToBrowsing() {
  let target = returnTabId;
  returnTabId = null;
  if (target == null) {
    const tabs = await browser.tabs.query({ currentWindow: true, hidden: false });
    target = tabs.find((t) => t.id !== playerTabId)?.id;
  }
  if (target != null) browser.tabs.update(target, { active: true }).catch(() => {});
}

// L'onglet du lecteur n'est visible que tant qu'on est dessus
browser.tabs.onActivated.addListener(({ tabId, previousTabId }) => {
  const shown = tabId === playerTabId;
  if (shown !== playerShown) {
    playerShown = shown;
    update();
  }
  if (settings.hideTab && previousTabId != null && previousTabId === playerTabId) {
    browser.tabs.hide(playerTabId).catch((e) => log(t("logHideError", e.message)));
  }
});

function connectPlayer(port) {
  // Firefox réinjecte le pont dans les onglets déjà ouverts quand l'extension est rechargée :
  // un tel onglet peut n'avoir jamais été affiché ou garder une vieille version de la page.
  // On le ferme : un onglet neuf s'ouvrira au prochain morceau.
  if (!opening) {
    log(t("logStaleTab"));
    browser.tabs.remove(port.sender.tab.id);
    return;
  }
  clearTimeout(opening);
  opening = null;
  playerPort = port;
  playerTabId = port.sender.tab.id;
  playerShown = !!port.sender.tab.active;
  coverShown = null; // page neuve : on lui redit tout de suite s'il faut cacher la vidéo
  syncCover();
  port.onMessage.addListener(onPlayerMessage);
  port.onDisconnect.addListener(() => {
    if (playerPort !== port) return;
    playerPort = null;
    playerState = -1;
    position = null;
    loadingSince = 0;
    playerShown = false;
    log(t("logTabClosed"));
    update();
    // Invité d'un salon : l'onglet est indispensable, on le rouvre et on reprend où en est l'hôte.
    // Sinon, panneau ouvert : on le rouvre aussi, sur l'écran du début
    if (inGuestRoom()) setTimeout(guestPlayerLost, 500);
    else if (ports.size) setTimeout(warmPlayer, 500);
  });
  for (const cmd of queued) port.postMessage(cmd);
  queued = [];
}

// Réglage changé : l'onglet du lecteur réapparaît dans la barre, ou s'y range s'il n'est pas affiché
async function applyHideTab() {
  if (playerTabId == null) return;
  if (!settings.hideTab) return browser.tabs.show(playerTabId).catch(() => {});
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== playerTabId) browser.tabs.hide(playerTabId).catch((e) => log(t("logHideError", e.message)));
}

// Ouvre l'onglet du lecteur d'avance, sans vidéo. Firefox ne lit les médias que dans un
// onglet passé au moins une fois au premier plan : mieux vaut le faire avant la partie
// qu'au début d'une manche. On revient à la navigation dès que le lecteur est prêt.
function warmPlayer() {
  if (playerPort || opening) return;
  warmup = true;
  openPlayerTab();
}

// Cache sur la vidéo, dans la page du lecteur : en blind test, rien n'est dévoilé même si
// l'onglet s'affiche (premier chargement, clic d'autorisation, nouvel essai…)
function videoHidden() {
  if (inGuestRoom()) return guestHidesVideo();
  return state.mode === "blind" && settings.blind.hideVideo && game.phase !== "revealed";
}

function syncCover() {
  if (!playerPort) return;
  const on = videoHidden();
  if (on === coverShown) return;
  coverShown = on;
  playerPort.postMessage({ action: "cover", on });
}

// En blind test, la vidéo ne doit pas rester sous les yeux
async function hidePlayerTab() {
  if (playerTabId == null) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) backToBrowsing();
}

// Affiche l'onglet du lecteur ; s'il est déjà affiché et que toggle est vrai, revient à la navigation
async function focusPlayer(toggle = false) {
  // 📺 est inactif en blind test joué ; seul l'écran d'autorisation peut y emmener.
  // L'animateur garde l'accès à la vidéo ; un invité la voit quand l'hôte ne la cache pas.
  const hidden = inGuestRoom() ? guestHidesVideo() : state.mode === "blind";
  if (playerTabId == null || !playerPort || (toggle && hidden)) return;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === playerTabId) {
    if (toggle) backToBrowsing();
    return;
  }
  returnTabId = active?.id ?? null;
  await browser.tabs.show(playerTabId);
  browser.tabs.update(playerTabId, { active: true });
}

let lastPlay = null;      // { item, opts } : dernier morceau lancé, rejoué si YouTube échoue
let retriedVisible = false; // reprise déjà tentée onglet affiché, depuis le dernier départ réussi

function play(i, opts = {}) {
  // Invité d'un salon : c'est l'hôte qui choisit la musique
  if (inGuestRoom() || !Number.isInteger(i) || i < 0 || i >= items().length) return;
  state.index = i;
  startTrack(items()[i], opts);
  save();
}

// Lance une piste (de la playlist ouverte, ou d'une partie de blind test)
function startTrack(item, opts = {}) {
  lastPlay = { item, opts };
  log(t("logPlaying", item.title));
  send({ action: "load", id: item.id, volume: settings.volume, ...opts });
  update();
}

function trackPosition(msg) {
  if (!msg.id || !Number.isFinite(Number(msg.time))) return;
  const now = Date.now();
  const time = Number(msg.time);
  const playing = msg.state === 1;
  const same = position?.id === msg.id;
  // Ancienne page du lecteur (sans durée dans ses positions) : celle du départ est gardée
  const duration = Number(msg.duration) > 0 ? Number(msg.duration) : same ? position.duration : 0;
  const expected = same ? position.time + (position.playing ? (now - position.at) / 1000 : 0) : null;
  const changed = !same || position.playing !== playing || position.duration !== duration || Math.abs(expected - time) > 1.5;
  position = { id: msg.id, time, duration, playing, at: now };
  if (changed) update();
}

function onPlayerMessage(msg) {
  switch (msg.type) {
    case "ready":
      log(t("logReady"));
      if (warmup) {
        warmup = false;
        if (returnAfterStart && !loadingSince) {
          clearTimeout(returnAfterStart);
          returnAfterStart = setTimeout(() => {
            returnAfterStart = null;
            backToBrowsing();
          }, 1000);
        }
      }
      break;
    case "log":
      log(msg.key ? t(msg.key) : String(msg.text ?? "")); // texte brut : ancienne page du lecteur en cache
      break;
    case "hello":
      log(t("logAutoplay", msg.autoplay));
      // La page demande, après le clic d'autorisation, s'il faut ranger l'onglet (une seule fois)
      playerPort?.postMessage({ action: "setup", askHide: !settings.tabAsked });
      if (msg.autoplay === "allowed") {
        startTips();
        // On reste sur l'onglet le temps que la vidéo démarre : masquer l'onglet pendant
        // le tout premier chargement semble parfois faire échouer YouTube
        clearTimeout(returnAfterStart);
        returnAfterStart = setTimeout(() => {
          returnAfterStart = null;
          backToBrowsing();
        }, 6000);
      } else {
        notice = { key: "noticeUnlock", focus: true };
        update();
      }
      break;
    case "blocked":
      loadingSince = 0;
      // On reste sur l'onglet : c'est là qu'il faut cliquer
      clearTimeout(returnAfterStart);
      returnAfterStart = null;
      log(t("logBlocked"));
      notice = { key: "noticeBlocked", focus: true };
      update();
      break;
    case "unblocked":
      notice = null;
      showReady();
      startTips();
      // La page propose maintenant de ranger l'onglet : on y reste le temps de la réponse
      if (!msg.asking) backToBrowsing();
      update();
      break;
    case "hideChoice":
      if (typeof msg.hide !== "boolean") break;
      settings.hideTab = msg.hide;
      settings.tabAsked = true;
      save();
      // Rangé : on revient à la navigation (l'onglet se masque en le quittant). Gardé : on y reste.
      if (msg.hide) backToBrowsing();
      else applyHideTab();
      update();
      break;
    case "tick":
      roomTick(msg);
      guestTick(msg);
      trackPosition(msg);
      break;
    case "state":
      log(t("logState", STATE_NAMES[msg.state] ? t(STATE_NAMES[msg.state]) : msg.state));
      playerState = msg.state;
      trackPosition(msg);
      roomTick(msg, true);
      guestTick(msg);
      if (msg.state === 0 && !inGuestRoom()) onEnded();
      update();
      break;
    case "started":
      retriedVisible = false;
      loadingSince = 0;
      if (position && Number(msg.duration) > 0) position.duration = Number(msg.duration);
      update();
      // Le son revient juste au démarrage, et Firefox peut encore couper la lecture pendant
      // ~2 s : on reste sur l'onglet le temps que le départ soit acquis.
      if (returnAfterStart) {
        clearTimeout(returnAfterStart);
        returnAfterStart = setTimeout(() => {
          returnAfterStart = null;
          backToBrowsing();
        }, 2500);
      }
      if (inGame() && game.phase === "playing") {
        // Dernier chapitre en « durée du chapitre » : sa fin dépend de la durée de la vidéo
        if (game.clip == null && game.chapter) {
          game.clip = Math.max(5, Math.floor(msg.duration - game.chapter.start));
          game.remaining = game.clip;
        }
        startCountdown();
      }
      break;
    case "error":
      loadingSince = 0;
      update();
      {
        const item = nowPlaying();
        log(t("logYoutubeError", msg.code, item ? `« ${item.title} » (${item.id})` : t("logNoTrack")));
      }
      if (msg.code === "playlist-empty") {
        notice = { key: "noticePrivatePlaylist" };
        update();
        break;
      }
      // YouTube refuse parfois de démarrer dans l'onglet masqué (« Une erreur s'est produite ») :
      // on l'affiche et on relance, comme le ferait un clic sur 📺
      if (retryVisible(msg.code)) {
        if (inGuestRoom()) guestRetry();
        else if (lastPlay) startTrack(lastPlay.item, lastPlay.opts);
        break;
      }
      if (inGuestRoom()) break; // la suite dépend de l'hôte
      if (inGame()) setTimeout(nextRound, 1000);
      else setTimeout(next, 1500);
      break;
    case "playlist": {
      const p = playlist(importTarget) ?? playlist();
      log(t("logImported", msg.ids.length));
      const start = p.items.length;
      addItems(p, msg.ids);
      if (state.mode === "listen" && p.id === state.current) play(start);
      save();
      break;
    }
  }
}

// Erreurs définitives (vidéo supprimée, privée, intégration interdite) : rien à retenter
const PERMANENT_ERRORS = [100, 101, 150, 153];

function retryVisible(code) {
  if (retriedVisible || PERMANENT_ERRORS.includes(Number(code)) || playerTabId == null) return false;
  retriedVisible = true;
  log(t("logRetryVisible"));
  showForRetry();
  return true;
}

async function showForRetry() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== playerTabId) {
    returnTabId = active?.id ?? null;
    await browser.tabs.show(playerTabId).catch(() => {});
    browser.tabs.update(playerTabId, { active: true }).catch(() => {});
  }
  // Retour à la navigation après le départ (voir « started »), ou au plus tard dans 15 s
  clearTimeout(returnAfterStart);
  returnAfterStart = setTimeout(() => {
    returnAfterStart = null;
    backToBrowsing();
  }, 15000);
}

function onEnded() {
  if (state.mode === "listen") next();
  else if (game.phase === "playing") timeUp();
}
