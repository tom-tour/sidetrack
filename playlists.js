// Playlists : création, liens YouTube, chapitres, sauvegarde, export, et le mode Playlist
// (suivant, précédent, lecture / pause). Fait partie du moteur (voir background.js).

const EXPORT_CHUNK = 50;

// --- Playlists -------------------------------------------------------------

function playlist(id = state.current) {
  return state.playlists.find((p) => p.id === id);
}

function items() {
  return playlist()?.items ?? [];
}

function newPlaylist(name) {
  const p = { id: crypto.randomUUID(), name, items: [] };
  state.playlists.push(p);
  return p;
}

function selectPlaylist(id) {
  if (state.current === id || !playlist(id)) return;
  state.current = id;
  state.index = -1;
  resetGame();
  send({ action: "pause" });
  update();
  save();
}

// Restauration d'une sauvegarde (fichier JSON fait par le bouton 💾 des réglages). Tout est
// vérifié : un fichier abîmé ou modifié à la main n'ajoute que ce qui est valable.
function restorePlaylists(data) {
  if (data?.app !== "sidetrack" || !Array.isArray(data.playlists)) {
    notice = { key: "noticeBadBackup" };
    update();
    return "noticeBadBackup";
  }
  let lists = 0;
  let tracks = 0;
  for (const raw of data.playlists.slice(0, 500)) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) continue;
    const items = raw.items
      .filter((it) => it && typeof it.id === "string" && /^[\w-]{11}$/.test(it.id))
      .slice(0, 5000)
      .map((it) => {
        const item = { id: it.id, title: cleanText(it.title, 300) || it.id };
        if (Array.isArray(it.chapters)) {
          item.chapters = it.chapters
            .filter((c) => c && Number.isFinite(c.start) && c.start >= 0)
            .map((c) => ({ title: cleanText(c.title, 200), start: Math.floor(c.start) }));
        }
        return item;
      });
    const name = cleanText(raw.name, 80) || t("defaultPlaylist");
    // Même playlist (même identifiant) déjà là : son contenu est remplacé par celui du fichier
    const id = typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : null;
    let p = id && state.playlists.find((x) => x.id === id);
    if (!p) {
      p = newPlaylist(name);
      if (id) p.id = id;
    }
    p.name = name;
    p.items = items;
    if (typeof raw.preset === "string" && PRESETS[raw.preset]) p.preset = raw.preset;
    lists++;
    tracks += items.length;
  }
  // La playlist affichée et la musique en cours ne changent pas : les autres sont dans la liste
  notice = { key: "noticeRestored", args: [lists, tracks] };
  update();
  save();
}

// Playlist toute prête (presets.js) : ajoutée une fois, puis simplement affichée
function addPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  let p = state.playlists.find((x) => x.preset === key);
  if (!p) {
    p = newPlaylist(t(preset.name));
    p.preset = key;
    p.items = preset.items.map(([id, title]) => ({ id, title }));
    log(t("logPreset", p.name, p.items.length));
  }
  selectPlaylist(p.id);
  update();
  save();
}

function deletePlaylist() {
  state.playlists = state.playlists.filter((p) => p.id !== state.current);
  state.current = null;
  selectPlaylist((state.playlists[0] ?? newPlaylist(t("defaultPlaylist"))).id);
}

// --- Ajout de liens ----------------------------------------------------------

function parseLink(text) {
  text = String(text ?? "").trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text, list: null };
  try {
    const u = new URL(text);
    let id = u.searchParams.get("v");
    if (u.hostname === "youtu.be") id = u.pathname.slice(1, 12);
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
    if (m) id = m[2];
    if (id && !/^[\w-]{11}$/.test(id)) id = null;
    return { id, list: u.searchParams.get("list") };
  } catch {
    return { id: null, list: null };
  }
}

async function fetchTitle(item) {
  try {
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + item.id)
    );
    item.title = r.ok ? (await r.json()).title : t("unavailable", item.id);
  } catch {
    item.title = item.id;
  }
  update();
  save();
}

// --- Chapitres --------------------------------------------------------------
// Le lecteur intégré ne donne pas les chapitres : on les lit dans la page de la vidéo
// (ytInitialData). Résultat mis en cache dans l'élément : [{ title, start }] en secondes.

function collectChapters(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectChapters(n, out);
  } else if (node && typeof node === "object") {
    const c = node.chapterRenderer;
    if (c && typeof c.timeRangeStartMillis === "number") {
      out.push({ title: c.title?.simpleText ?? "", start: Math.floor(c.timeRangeStartMillis / 1000) });
    }
    for (const key in node) collectChapters(node[key], out);
  }
}

async function fetchChapters(item) {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${item.id}`);
    const m = (await r.text()).match(/var ytInitialData = (\{.*?\});<\/script>/s);
    const found = [];
    if (m) collectChapters(JSON.parse(m[1]), found);
    const seen = new Set();
    item.chapters = found
      .filter((c) => !seen.has(c.start) && seen.add(c.start))
      .sort((a, b) => a.start - b.start);
  } catch (e) {
    log(t("logChaptersError", item.title, e.message));
    item.chapters = [];
  }
}

async function ensureChapters(list) {
  const missing = list.filter((item) => !Array.isArray(item.chapters));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(fetchChapters));
  }
  if (missing.length) save();
}

function addItems(p, ids) {
  for (const id of ids) {
    const item = { id, title: id };
    p.items.push(item);
    fetchTitle(item);
  }
}

function addLink(text) {
  const p = playlist();
  const { id, list } = parseLink(text);
  if (list && !id) {
    importTarget = p.id;
    log(t("logImporting", list));
    send({ action: "playlist", list });
  } else if (id) {
    addItems(p, [id]);
    if (state.mode === "listen" && (state.index < 0 || playerState === 0)) play(p.items.length - 1);
  } else {
    log(t("logBadLink"));
  }
  update();
  save();
}

// Glisser-déposer dans la file : le morceau en cours reste le même
function moveItem(from, to) {
  const list = items();
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const current = list[state.index];
  list.splice(to, 0, list.splice(from, 1)[0]);
  state.index = current ? list.indexOf(current) : -1;
  update();
  save();
}

// Chapitres d'une vidéo, quelle que soit sa playlist (liste d'une partie de blind test comprise)
async function loadChapters(id) {
  const item = state.playlists.flatMap((p) => p.items).find((it) => it.id === id);
  if (!item) return;
  await ensureChapters([item]);
  update();
}

function removeItem(i) {
  if (!items()[i]) return;
  items().splice(i, 1);
  if (i < state.index) state.index--;
  else if (i === state.index) state.index = -1;
  update();
  save();
}

// --- Export vers YouTube ---------------------------------------------------
// watch_videos crée une playlist temporaire sans connexion ni clé d'API,
// que l'utilisateur enregistre ensuite dans son compte. 50 vidéos maximum par lien.

async function exportPlaylist() {
  const ids = items().map((item) => item.id);
  if (!ids.length) {
    notice = { key: "noticeExportEmpty" };
    return update();
  }
  const parts = Math.ceil(ids.length / EXPORT_CHUNK);
  for (let i = 0; i < parts; i++) {
    const chunk = ids.slice(i * EXPORT_CHUNK, (i + 1) * EXPORT_CHUNK);
    await browser.tabs.create({
      url: "https://www.youtube.com/watch_videos?video_ids=" + chunk.join(","),
      active: i === 0,
    });
  }
  notice = parts > 1 ? { key: "noticeExportedParts", args: [parts] } : { key: "noticeExported" };
  log(t("logExport", ids.length, parts));
}

// --- Mode écoute -----------------------------------------------------------

function next() {
  const n = items().length;
  if (!n) return;
  if (state.shuffle && n > 1) {
    let i;
    do i = Math.floor(Math.random() * n); while (i === state.index);
    play(i);
  } else if (state.index + 1 < n) {
    play(state.index + 1);
  }
}

function prev() {
  if (state.index > 0) play(state.index - 1);
}

function toggle() {
  if (!items().length || gameRunning()) return;
  // Pas encore de morceau, ou onglet du lecteur fermé : on (re)lance le morceau
  if (state.index < 0 || !playerPort) return play(Math.max(0, state.index));
  send({ action: playerState === 1 ? "pause" : "play" });
}
