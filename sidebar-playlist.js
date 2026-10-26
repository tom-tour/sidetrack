// Onglet Playlist du panneau : barre des playlists, playlists toutes prêtes, lien (rempli depuis
// l'onglet YouTube actif), commandes de lecture et file de lecture.

// --- Barre des playlists ---------------------------------------------------

let editing = null; // "new" | "rename" | null

function startEditing(kind) {
  editing = kind;
  const input = $("#pl-name");
  const current = view.state.playlists.find((p) => p.id === view.state.current);
  input.value = kind === "rename" ? current?.name ?? "" : "";
  input.hidden = false;
  $("#pl-select").hidden = true;
  input.focus();
  input.select();
}

function stopEditing(commit) {
  const name = $("#pl-name").value.trim();
  if (commit && name) act(editing === "new" ? "createPlaylist" : "renamePlaylist", name);
  editing = null;
  $("#pl-name").hidden = true;
  $("#pl-select").hidden = false;
}

$("#pl-select").addEventListener("change", (e) => act("selectPlaylist", e.target.value));
$("#pl-new").addEventListener("click", () => startEditing("new"));
$("#pl-rename").addEventListener("click", () => startEditing("rename"));
$("#pl-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") stopEditing(true);
  if (e.key === "Escape") stopEditing(false);
});
$("#pl-name").addEventListener("blur", () => editing && stopEditing(true));
$("#pl-export").addEventListener("click", () => act("exportPlaylist"));

// Suppression d'une playlist : « Sûr ? », second clic dans les 3 s (common/ui.js)
const sure = createSure(() => render());
$("#pl-delete").addEventListener("click", () => sure.click("delete", () => act("deletePlaylist")));

// 📚 : les playlists toutes prêtes ; un clic l'ajoute (ou l'affiche si elle est déjà là)
let presetsOpen = false;
$("#pl-presets").addEventListener("click", () => {
  presetsOpen = !presetsOpen;
  render();
});

function renderPresets() {
  const shown = view.settings.showPresets;
  $("#pl-presets").hidden = !shown;
  if (!shown) presetsOpen = false;
  $("#presets").hidden = !presetsOpen;
  $("#pl-presets").classList.toggle("on", presetsOpen);
  if (!presetsOpen) return;
  $("#preset-list").replaceChildren(
    ...Object.entries(PRESETS).map(([key, preset]) =>
      button(t("presetCount", t(preset.name), preset.items.length), () => {
        presetsOpen = false;
        act("addPreset", key);
      })
    )
  );
}

$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#url").value.trim();
  if (!text) return;
  act("addLink", text);
  $("#url").value = "";
  if (text === filled) added = text;
  filled = "";
});

// Onglet actif sur une vidéo ou une playlist YouTube : son lien remplit le champ, tant que
// celui-ci est vide ou n'a pas été modifié (et sauf si ce lien vient d'être ajouté).
// Sans permission « tabs », Firefox ne donne l'adresse que des sites autorisés (youtube.com).
const YOUTUBE_PAGE = /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?|shorts\/|live\/|playlist\?)/;
let filled = "";  // lien mis par nous dans le champ
let added = "";   // dernier lien rempli puis ajouté : pas reproposé

async function fillFromTab() {
  const [tab] = (await browser.tabs?.query({ active: true, currentWindow: true }).catch(() => [])) ?? [];
  const link = YOUTUBE_PAGE.test(tab?.url ?? "") ? tab.url : "";
  const input = $("#url");
  if (input.value.trim() && input.value !== filled) return; // modifié à la main
  if (link && link === added) return;
  added = "";
  input.value = filled = link;
}

if (browser.tabs) {
  browser.tabs.onActivated.addListener(fillFromTab);
  browser.tabs.onUpdated.addListener((_id, change, tab) => tab.active && change.url && fillFromTab(), { properties: ["url"] });
  browser.windows?.onFocusChanged.addListener(fillFromTab);
  fillFromTab();
}

// --- Lecture ------------------------------------------------------------------

$("#prev").addEventListener("click", () => act("prev"));
$("#next").addEventListener("click", () => act("next"));
$("#toggle").addEventListener("click", () => act("toggle"));
$("#shuffle").addEventListener("click", () => act("toggleShuffle"));

function renderQueue(index) {
  if (dragging) return; // reconstruire la liste annulerait le glisser-déposer en cours
  if (!changed("queue", view.state.current, index, itemsKey(items()))) return;
  $("#queue").replaceChildren(...trackList(index));
  $("#empty").hidden = items().length > 0;
}

// Partie de blind test en cours pendant qu'on regarde les playlists : on peut les modifier,
// mais rien ne se lance avant d'avoir arrêté la partie
$("#game-back").addEventListener("click", () => chooseTab(view.state.mode));
$("#game-stop").addEventListener("click", () => {
  act("stopGame");
  act("setMode", "listen");
  tab = null;
});

function renderGameBanner(game) {
  $("#game-banner").hidden = !gameLocked;
  for (const id of ["#prev", "#toggle", "#next"]) {
    $(id).disabled = gameLocked;
  }
  $("#listen .controls").title = gameLocked ? t("lockedTitle") : "";
  $("#queue").classList.toggle("locked", gameLocked);
  if (!gameLocked) return;
  const where = game.phase === "loading" ? t("loadingChapters") : t("round", game.pos + 1, game.order.length);
  $("#game-banner-text").textContent = t("gameRunning", where);
}

// Liste des playlists (sauf pendant un renommage) et bouton 🗑 (« Sûr ? »)
function renderPlaylistBar(state) {
  if (!editing) {
    $("#pl-select").replaceChildren(
      ...state.playlists.map((p) => {
        const o = new Option(`${p.name} (${p.items.length})`, p.id);
        o.selected = p.id === state.current;
        return o;
      })
    );
  }
  const armed = sure.armed("delete");
  $("#pl-delete").textContent = armed ? t("sure") : "🗑";
  $("#pl-delete").classList.toggle("danger", armed);
  $("#shuffle").classList.toggle("on", state.shuffle);
}
