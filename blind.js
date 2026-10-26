// Blind test, joué (« blind ») ou animé par l'hôte d'un salon (« emcee »). Fait partie du
// moteur (voir background.js) ; les points d'un salon sont dans room.js.

// --- Mode blind test -------------------------------------------------------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Playlists jouées : celles cochées dans l'onglet Blind test, sinon la playlist ouverte
function blindSources() {
  const ids = state.blindSources.filter((id) => playlist(id));
  return ids.length ? ids : [state.current];
}

// Pistes des playlists jouées, sans doublon (une vidéo présente dans deux playlists)
function buildDeck() {
  const seen = new Set();
  return blindSources()
    .flatMap((id) => playlist(id)?.items ?? [])
    .filter((item) => !seen.has(item.id) && seen.add(item.id));
}

// Pistes de la partie en cours (fixées au départ), ou celles qu'elle aurait
function deck() {
  return game.tracks.length ? game.tracks : buildDeck();
}

function setBlindSources(ids) {
  if (!Array.isArray(ids)) return;
  state.blindSources = [...new Set(ids.filter((id) => typeof id === "string" && playlist(id)))];
  if (["idle", "over"].includes(game.phase)) resetGame();
  update();
  save();
}

// Partie commencée et pas finie : changer d'onglet ne l'arrête pas, le mode Playlist attend
function gameRunning() {
  return inGame() && !["idle", "over"].includes(game.phase);
}

// game.tracks : pistes de la partie ; game.order : manches [{ i, chapter? }], i dans game.tracks ;
// game.track : piste de la manche ; game.clip : durée de la manche en cours
// (0 = morceau entier, null = inconnue tant que la vidéo n'a pas démarré) ; game.startAt : début
// de l'extrait dans la vidéo ; game.history : manches jouées, pour le récapitulatif de fin
function resetGame() {
  clearInterval(gameTimer);
  game = {
    phase: "idle", tracks: [], track: null, order: [], pos: -1, score: 0, played: 0, remaining: 0, clip: 0,
    chapter: null, nextIn: 0, guesses: [], lastPoints: 0, elapsed: 0, hintText: "", hintOrder: [],
    startAt: null, history: [],
  };
}

// Arrêter la partie (bouton du bandeau de l'onglet Playlist, ou de l'onglet Blind test)
function stopGame() {
  if (!inGame()) return;
  resetGame();
  send({ action: "pause" });
  update();
}

// --- Réglages tout faits -------------------------------------------------------

const FORMULAS = {
  express: { rounds: 10, startMode: "random", clip: 15, pause: 5, hints: true },
  classic: { rounds: 20, startMode: "random", clip: 30, pause: 10, hints: true },
  chapters: { rounds: 0, startMode: "chapter", clip: -1, pause: 10, hints: true },
};

function applyFormula(name) {
  const formula = FORMULAS[name];
  if (!formula) return;
  Object.assign(settings.blind, formula);
  update();
  save();
}

// Manche identifiée d'une partie à l'autre : « vidéo » ou « vidéo:chapitre »
const PLAYED_MAX = 3000;
const roundKey = (tracks, { i, chapter }) => (chapter == null ? tracks[i].id : `${tracks[i].id}:${chapter}`);

function rememberPlayed(key) {
  state.blindPlayed = state.blindPlayed.filter((k) => k !== key);
  state.blindPlayed.push(key);
  if (state.blindPlayed.length > PLAYED_MAX) state.blindPlayed.splice(0, state.blindPlayed.length - PLAYED_MAX);
}

// Ordre des manches : au hasard, les jamais jouées d'abord (réglage « fresh »), puis le
// nombre de manches choisi
function orderRounds(rounds, tracks) {
  let order = shuffle(rounds);
  if (settings.blind.fresh) {
    const played = new Map(state.blindPlayed.map((k, n) => [k, n]));
    const fresh = order.filter((r) => !played.has(roundKey(tracks, r)));
    // Déjà jouées : les plus anciennes d'abord
    const old = order.filter((r) => played.has(roundKey(tracks, r))).sort((a, b) => played.get(roundKey(tracks, a)) - played.get(roundKey(tracks, b)));
    order = [...fresh, ...old];
  }
  return settings.blind.rounds ? order.slice(0, settings.blind.rounds) : order;
}

// Titre de la réponse : chapitre et vidéo, ou la vidéo
function answerTitle() {
  const item = game.track;
  if (!item) return "";
  return game.chapter?.title ? `${game.chapter.title} · ${item.title}` : item.title;
}

// Réécouter l'extrait depuis son début (manche en cours)
function replayClip() {
  if (!["playing", "timeup"].includes(game.phase) || game.startAt == null) return;
  send({ action: "seek", time: game.startAt });
  if (game.phase === "timeup") send({ action: "play" });
}

// Récapitulatif : un clic réécoute la manche (partie finie, ou réponse révélée)
function blindReplay(k) {
  const entry = game.history[k];
  if (!entry || (gameRunning() && game.phase !== "revealed")) return;
  const item = game.tracks[entry.i];
  if (item) startTrack(item, { start: entry.at ?? 0 });
}

// --- Indices, façon pendu ---------------------------------------------------
// Les lettres du titre se dévoilent peu à peu : rien au premier quart de la manche, puis
// jusqu'à la moitié des lettres à 90 % du temps. Chaque lettre dévoilée baisse les points
// qu'une réponse, même parfaite, peut rapporter : 10 au départ, 5 quand la moitié est dévoilée.
const HINT_SHARE = 0.5;
const HINT_SCALE = 30; // durée de référence d'une manche sans fin connue (morceau entier)
const LETTER = /[\p{L}\p{N}]/u;

// Le texte à deviner, tel qu'affiché : sans les parenthèses (« Official Video »…)
function hintSource() {
  const item = nowPlaying();
  const text = game.chapter?.title || item?.title || "";
  return text.replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, " ").replace(/\s+/g, " ").trim();
}

function prepareHints() {
  game.hintText = hintSource();
  const letters = [...game.hintText].map((c, i) => (LETTER.test(c) ? i : -1)).filter((i) => i >= 0);
  game.hintOrder = shuffle(letters);
  game.elapsed = 0;
}

function hintCount() {
  if (!settings.blind.hints || !game.hintOrder.length) return 0;
  const length = game.clip || HINT_SCALE;
  const progress = Math.min(1, Math.max(0, (game.elapsed - 0.25 * length) / (0.65 * length)));
  return Math.floor(game.hintOrder.length * HINT_SHARE * progress);
}

function maxPoints() {
  if (!game.hintOrder.length) return 10;
  return Math.max(1, Math.round(10 * (1 - hintCount() / game.hintOrder.length)));
}

// « N _ _ _ _   G _ _ _ _ » : lettres dévoilées, les autres cachées, espaces et signes gardés
function hintMask() {
  if (!settings.blind.hints || !game.hintText) return null;
  const shown = new Set(game.hintOrder.slice(0, hintCount()));
  return [...game.hintText].map((c, i) => (!LETTER.test(c) || shown.has(i) ? c : "_")).join("");
}

// Temps écoulé : quelques secondes pour les réponses de dernière seconde, puis la réponse
const TIMEUP_GRACE = 3000;

async function startGame() {
  resetGame();
  resetScores(); // nouvelle partie dans un salon : tout le monde repart de zéro (room.js)
  const list = (game.tracks = buildDeck());
  let rounds = list.map((_, i) => ({ i }));
  if (settings.blind.startMode === "chapter") {
    // Une manche par chapitre ; une vidéo sans chapitres reste une seule manche
    game.phase = "loading";
    update();
    const current = game;
    await ensureChapters(list);
    if (game !== current || game.phase !== "loading") return; // partie annulée entre-temps
    rounds = list.flatMap((item, i) =>
      item.chapters.length ? item.chapters.map((_, chapter) => ({ i, chapter })) : [{ i }]
    );
    log(t("logChapterGame", rounds.length));
  }
  game.order = orderRounds(rounds, game.tracks);
  nextRound();
}

// L'hôte choisit la prochaine manche (une piste, ou un chapitre) : elle part tout de suite.
// Sans partie en cours, on en commence une faite des manches choisies à la main.
async function blindPick(i, chapter = null) {
  const tracks = deck();
  const item = tracks[i];
  if (!item || !inGame() || game.phase === "loading") return;
  if (chapter != null) {
    await ensureChapters([item]);
    if (!item.chapters?.[chapter]) return;
  }
  if (game.phase === "idle" || game.phase === "over") {
    resetGame();
    game.tracks = tracks;
  }
  const same = (r) => r.i === i && (r.chapter ?? null) === chapter;
  // Si cette manche était prévue plus loin, on la retire pour ne pas la rejouer
  const later = game.order.findIndex((r, k) => k > game.pos && same(r));
  if (later >= 0) game.order.splice(later, 1);
  game.order.splice(game.pos + 1, 0, chapter == null ? { i } : { i, chapter });
  nextRound();
}

function nextRound() {
  clearInterval(gameTimer);
  game.pos++;
  game.guesses = [];
  game.lastPoints = 0;
  if (game.pos >= game.order.length) {
    game.phase = "over";
    send({ action: "pause" });
    return update();
  }
  const { i, chapter } = game.order[game.pos];
  const { clip, startMode } = settings.blind;
  const item = (game.track = game.tracks[i]);
  const chapters = item.chapters;
  game.phase = "playing";
  game.startAt = null;
  rememberPlayed(roundKey(game.tracks, game.order[game.pos]));

  if (chapter != null) {
    const start = chapters[chapter].start;
    const end = chapters[chapter + 1]?.start ?? null;
    game.chapter = { title: chapters[chapter].title, start };
    const length = end != null ? end - start : null;
    if (clip === -1) game.clip = length;
    else if (clip && length != null) game.clip = Math.min(clip, length);
    else game.clip = clip;
    startTrack(item, { start });
  } else {
    // « Durée du chapitre » sans chapitre : extrait de 20 s
    game.chapter = null;
    game.clip = clip === -1 ? 20 : clip;
    startTrack(item, { randomStart: startMode !== "start", clip: game.clip });
  }
  game.remaining = game.clip ?? 0;
  game.history.push({ i, chapter: chapter ?? null, title: answerTitle(), at: game.chapter?.start ?? null, points: null, found: null });
  prepareHints();
  save();
}

function startCountdown() {
  clearInterval(gameTimer);
  game.elapsed = 0;
  // Chaque seconde : le temps qui reste (si l'extrait a une durée) et les indices qui avancent
  gameTimer = setInterval(() => {
    game.elapsed++;
    if (game.clip) {
      game.remaining--;
      if (game.remaining <= 0) return timeUp();
    }
    update();
  }, 1000);
  update();
}

function timeUp() {
  clearInterval(gameTimer);
  game.remaining = 0;
  game.phase = "timeup";
  send({ action: "pause" });
  // Partie automatique : la réponse suit d'elle-même
  if (settings.blind.pause > 0) gameTimer = setTimeout(reveal, TIMEUP_GRACE);
  update();
}

function reveal() {
  if (game.phase !== "playing" && game.phase !== "timeup") return;
  clearInterval(gameTimer);
  game.phase = "revealed";
  game.answered = false;
  unmaskGuesses();
  autoScore();
  // Seul, points à l'écrit : la meilleure réponse de la manche, sur 10
  if (!room && settings.blind.judge !== "self") {
    game.lastPoints = soloPoints();
    game.score += game.lastPoints;
    game.played += 10;
    game.answered = true;
    game.history.at(-1).points = game.lastPoints;
  }
  // Moment réellement entendu (départ aléatoire compris), pour réécouter depuis le récapitulatif
  if (game.startAt != null) game.history.at(-1).at = game.startAt;
  send({ action: "play" });
  // Partie automatique : la manche suivante part après la pause réglée
  game.nextIn = settings.blind.pause > 0 ? settings.blind.pause : 0;
  if (game.nextIn) {
    gameTimer = setInterval(() => {
      game.nextIn--;
      if (game.nextIn > 0) return update();
      // Seul et juge de soi-même, sans réponse donnée : la manche compte comme ratée
      if (!room && settings.blind.judge === "self") answer(false);
      else nextRound();
    }, 1000);
  }
  update();
}

function answer(found) {
  if (game.phase !== "revealed" || game.answered) return;
  game.answered = true;
  if (game.history.length) game.history.at(-1).found = !!found;
  if (found) game.score++;
  game.played++;
  nextRound();
}
