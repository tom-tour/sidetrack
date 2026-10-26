// Page hébergée sur une vraie origine https : YouTube accepte d'y intégrer son lecteur.
// L'extension l'ouvre dans un onglet masqué et la pilote par postMessage,
// relayé par son script de contenu (player-bridge.js).

let player = null;
let pending = null;
let importingPlaylist = false;
let randomStart = null;  // { clip } : sauter à un moment aléatoire avant d'annoncer le départ
let announced = false;
let unmutedAt = 0;       // Firefox met en pause un lecteur qui reprend le son sans clic préalable
let volume = 100;
let wantPlaying = false;
let stalled = 0;
let lastPing = 0;        // dernier signe de vie de l'extension
let lastCheck = 0;       // dernier passage du minuteur de surveillance
let orphaned = false;

let lastLoad = null;     // dernière commande « load », rejouée en cas d'échec
let retried = false;     // une seule nouvelle tentative par chargement
let stallRestarts = 0;

const unlock = document.getElementById("unlock");
const stepSound = document.getElementById("step-sound");
const stepHide = document.getElementById("step-hide");
const cover = document.getElementById("cover");
let askHide = false;     // l'extension veut qu'on propose de ranger l'onglet (la première fois)

// Textes de la page, dans la langue du navigateur (moteur de traduction : ../common/i18n-core.js)
const STRINGS = {
  fr: {
    setupTitle: "Sidetrack est presque prêt",
    setupClick: "Firefox n'autorise le son dans un onglet qu'après un clic dans celui-ci. Sans ce clic, Sidetrack ne peut lire aucune vidéo (une fois par session).",
    unlock: "🔊 Autoriser Sidetrack à lire des vidéos dans cet onglet",
    hideTitle: "Ranger l'onglet de lecture ?",
    hideWhy: "Sidetrack lit les vidéos dans cet onglet : la musique continue ainsi sans que le panneau de Sidetrack ait besoin de rester ouvert.",
    hideHow: "Rangé, l'onglet quitte la barre d'onglets et revient d'un clic sur 📺 dans le panneau. Ce choix se change à tout moment dans les réglages de Sidetrack.",
    setupHide: "Une petite bulle peut s'afficher en haut à droite de Firefox (« Une extension masque certains de vos onglets ») : cliquer sur « Garder les onglets masqués ».",
    hideYes: "Ranger l'onglet",
    hideNo: "Garder l'onglet visible",
    orphan: "Sidetrack n'est plus actif : cet onglet peut être fermé.",
  },
  en: {
    setupTitle: "Sidetrack is almost ready",
    setupClick: "Firefox only allows sound in a tab after a click in it. Without this click, Sidetrack can't play any video (once per session).",
    unlock: "🔊 Allow Sidetrack to play videos in this tab",
    hideTitle: "Tuck the player tab away?",
    hideWhy: "Sidetrack plays videos in this tab: that way the music keeps going without the Sidetrack sidebar having to stay open.",
    hideHow: "Tucked away, the tab leaves the tab bar and comes back with 📺 in the sidebar. You can change your mind at any time in the Sidetrack settings.",
    setupHide: "A small bubble may show up at the top right of Firefox (“An extension is hiding some of your tabs”): click “Keep Tabs Hidden”.",
    hideYes: "Tuck the tab away",
    hideNo: "Keep the tab visible",
    orphan: "Sidetrack is no longer active: you can close this tab.",
  },
};
applyI18n();

function send(msg) {
  window.postMessage({ sidetrack: true, ...msg }, location.origin);
}

// Volume 0 : on garde 1 %. Firefox ralentit un onglet masqué qui ne fait aucun bruit, la
// lecture de l'hôte saccade alors et tous les invités, recalés sur lui, saccadent avec.
const audible = (v) => Math.max(1, v);

function unMute() {
  player.unMute();
  player.setVolume(audible(volume));
}

// Écran d'autorisation (de nouveau si Firefox bloque le son plus tard)
function showUnlock() {
  stepSound.hidden = false;
  stepHide.hidden = true;
  unlock.hidden = false;
}

// Seul le bouton ferme l'écran : un clic à côté ne fait rien
document.getElementById("allow").addEventListener("click", () => {
  if (player?.playVideo) {
    unMute();
    if (player.getPlayerState() === YT.PlayerState.PAUSED) player.playVideo();
  }
  // La première fois, on propose de ranger l'onglet avant de revenir à la navigation
  if (askHide) {
    stepSound.hidden = true;
    stepHide.hidden = false;
  } else {
    unlock.hidden = true;
  }
  send({ type: "unblocked", asking: askHide });
});

for (const [id, hide] of [["hide-yes", true], ["hide-no", false]]) {
  document.getElementById(id).addEventListener("click", () => {
    askHide = false;
    unlock.hidden = true;
    send({ type: "hideChoice", hide });
  });
}

// Sans clic dans cette page, Firefox refuse le son : on propose le clic tout de suite.
const autoplay = navigator.getAutoplayPolicy?.("mediaelement") ?? "unknown";
if (autoplay !== "allowed") showUnlock();
send({ type: "hello", autoplay });

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { autoplay: 1, playsinline: 1 },
    events: {
      onReady: () => {
        send({ type: "ready" });
        if (pending) run(pending);
        pending = null;
      },
      onStateChange: (e) => {
        send({ type: "state", state: e.data, ...position() });
        if (e.data === YT.PlayerState.PLAYING) onPlaying();
        if (e.data === YT.PlayerState.PAUSED) {
          if (Date.now() - unmutedAt < 2000) {
            showUnlock();
            send({ type: "blocked" });
          } else {
            wantPlaying = false; // pause demandée (ou faite directement dans l'onglet)
          }
        }
        if (importingPlaylist && e.data === YT.PlayerState.CUED) sendPlaylist(0);
      },
      onError: (e) => {
        // Le tout premier chargement échoue parfois sans raison : on retente une fois
        if (lastLoad && !retried) {
          retried = true;
          send({ type: "log", key: "logRetry" });
          setTimeout(() => load(lastLoad, true), 1000);
          return;
        }
        wantPlaying = false; // sinon le filet de sécurité relancerait la vidéo en erreur
        send({ type: "error", code: e.data });
      },
    },
  });
};

// Prévient l'extension quand la lecture démarre vraiment (après un éventuel saut).
function onPlaying() {
  if (announced) return;
  if (randomStart) {
    const duration = player.getDuration();
    const { clip } = randomStart;
    randomStart = null;
    if (duration > 0) {
      const max = Math.max(0, duration - (clip || 30) - 5);
      const min = Math.min(duration * 0.1, max);
      player.seekTo(min + Math.random() * (max - min), true);
      waitPlaying(0);
      return;
    }
  }
  announced = true;
  unmutedAt = Date.now();
  unMute();
  send({ type: "started", duration: player.getDuration() });
}

function waitPlaying(attempt) {
  if (announced) return;
  if (player.getPlayerState() === YT.PlayerState.PLAYING && attempt > 0) onPlaying();
  else if (attempt < 40) setTimeout(() => waitPlaying(attempt + 1), 250);
}

function sendPlaylist(attempt) {
  const ids = player.getPlaylist();
  if (ids?.length) {
    importingPlaylist = false;
    send({ type: "playlist", ids });
  } else if (attempt < 20) {
    setTimeout(() => sendPlaylist(attempt + 1), 250);
  } else {
    importingPlaylist = false;
    send({ type: "error", code: "playlist-empty" });
  }
}

// Vidéo et position actuelles (pour synchroniser les invités d'un salon)
function position() {
  return { id: player.getVideoData()?.video_id, time: player.getCurrentTime(), duration: player.getDuration() };
}

function load(cmd, retry = false) {
  lastLoad = cmd;
  retried = retry;
  stallRestarts = 0;
  announced = false;
  wantPlaying = true;
  if (cmd.volume != null) volume = cmd.volume;
  randomStart = cmd.randomStart ? { clip: cmd.clip } : null;
  // Démarrage toujours en muet : c'est la seule lecture automatique que Firefox autorise
  // sans clic. Le son revient dans onPlaying, après l'éventuel saut aléatoire.
  player.mute();
  player.loadVideoById({ videoId: cmd.id, startSeconds: cmd.start ?? 0 });
}

function run(cmd) {
  if (!player?.loadVideoById) {
    pending = cmd;
    return;
  }
  switch (cmd.action) {
    case "load":
      load(cmd);
      break;
    case "playlist":
      importingPlaylist = true;
      player.cuePlaylist({ listType: "playlist", list: cmd.list });
      break;
    case "play":
      unmutedAt = 0;
      wantPlaying = true;
      player.playVideo();
      break;
    case "pause":
      unmutedAt = 0;
      wantPlaying = false;
      player.pauseVideo();
      break;
    case "volume":
      volume = cmd.value;
      if (!player.isMuted()) player.setVolume(audible(volume));
      break;
    case "seek":
      player.seekTo(cmd.time, true);
      break;
  }
}

window.addEventListener("message", (e) => {
  // On ignore nos propres messages sortants (ils ont un "type", pas d'"action")
  if (e.source !== window || !e.data?.sidetrack || !e.data.action) return;
  if (e.data.action === "ping") {
    lastPing = Date.now();
    return;
  }
  if (e.data.action === "orphan") return shutDown();
  // Fonctionne même avant que le lecteur YouTube soit prêt
  if (e.data.action === "cover") {
    cover.hidden = !e.data.on;
    return;
  }
  if (e.data.action === "setup") {
    askHide = !!e.data.askHide;
    return;
  }
  run(e.data);
});

// L'extension n'est plus là (désinstallée, désactivée ou rechargée) : on s'arrête
function shutDown() {
  if (orphaned) return;
  orphaned = true;
  player?.pauseVideo?.();
  window.close();
  document.body.textContent = t("orphan");
  document.body.style.cssText = "color:#fff;display:flex;align-items:center;justify-content:center";
}

// Filet de sécurité et détection de la désinstallation
setInterval(() => {
  if (!player?.getPlayerState || orphaned) return;
  const state = player.getPlayerState();
  send({ type: "tick", state, ...position() });

  // Une lecture demandée qui reste bloquée au départ est relancée
  if (wantPlaying && (unlock.hidden || !stepHide.hidden) && (state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.CUED)) {
    if (++stalled >= 3) {
      stalled = 0;
      // Deux relances sans effet : on recharge carrément la vidéo (une fois)
      if (++stallRestarts > 2 && lastLoad && !retried) {
        send({ type: "log", key: "logReload" });
        load(lastLoad, true);
      } else {
        send({ type: "log", key: "logRetry" });
        player.playVideo();
      }
    }
  } else {
    stalled = 0;
  }

  // Secours : plus aucun signe de vie depuis une minute. Firefox ralentit les minuteurs
  // des onglets en arrière-plan : si ce minuteur-ci a lui-même pris du retard, les signes
  // de vie aussi, et on ne conclut rien.
  const now = Date.now();
  if (now - lastCheck > 5000) lastPing = Math.max(lastPing, now);
  lastCheck = now;
  if (lastPing && now - lastPing > 60000) shutDown();
}, 1000);
