// Salon du panneau (bouton 🌐) : créer, rejoindre, chat, fiches des personnes ; et l'écran
// d'un invité dans le salon de quelqu'un d'autre.

// --- Salon -------------------------------------------------------------------

// Bouton 🌐 : affiche les deux lignes du salon au-dessus des onglets
let roomOpen = false;
let hadRoom = false;
let lastSeenId = 0;   // dernier message lu (chat déplié)
let lastHeardId = 0;  // dernier message ayant déclenché le son

$("#toggle-room").addEventListener("click", () => {
  roomOpen = !roomOpen;
  if (roomOpen) act("refreshPublicRooms");
  render();
});

// Même règle que room.js : minuscules, sans accents, espaces → tirets
function roomName(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

function suggestName() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
$("#room-name").value = suggestName();

// Un seul bouton : « Rejoindre » si le nom est celui d'un salon public listé, sinon « Créer ».
// Un nom de salon privé déjà ouvert fait aussi rejoindre (voir openRoom dans room.js).
function listedRoom() {
  const name = roomName($("#room-name").value);
  return view?.rooms.list.find((r) => r.code === name);
}

// Premier salon : le pseudo de la ligne (pré-remplie avec celui proposé) est gardé, avec OK
// ou en entrant dans un salon
function commitName() {
  if (view.settings.nameSet) return;
  const name = $("#ask-name").value.trim();
  if (name && name !== view.settings.nickname) act("setSetting", "nickname", name);
  else act("setSetting", "nameSet", true);
}
$("#name-ask").addEventListener("submit", (e) => {
  e.preventDefault();
  commitName();
  $("#room-name").focus();
});

$("#room-form").addEventListener("submit", (e) => {
  e.preventDefault();
  commitName();
  const name = roomName($("#room-name").value) || suggestName();
  if (listedRoom()) act("joinRoom", name);
  else act("openRoom", { name, isPublic: $("#room-public").checked });
});
$("#room-name").addEventListener("input", () => render());
$("#public-refresh").addEventListener("click", () => act("refreshPublicRooms"));

$("#room-close").addEventListener("click", () => act(view.guest ? "leaveRoom" : "closeRoom"));
$("#share-moment").addEventListener("click", () => act("shareMoment"));
$("#room-copy").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText((view.room ?? view.guest).link);
    btn.textContent = t("copied");
  } catch {
    btn.textContent = (view.room ?? view.guest).link; // copie manuelle
  }
  setTimeout(() => (btn.textContent = t("copyLink")), 2000);
});
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  $("#chat-input").value = "";
  if (view.guest) return act("guestChat", text, secretGuess);
  const error = await ask("hostChat", text, secretGuess);
  // Trop rapide : le moteur affiche le bandeau errTooFast, et le texte n'est pas perdu
  if (error) $("#chat-input").value = text;
});

// Blind test : chacun choisit d'écrire sa réponse cachée (par défaut) ou en clair
let secretGuess = true;
$("#chat-secret").addEventListener("click", () => {
  secretGuess = !secretGuess;
  render();
});

// Invité, chacun se juge : une réponse par manche
let claimedRound = 0;
for (const [id, found] of [["#guest-found", true], ["#guest-missed", false]]) {
  $(id).addEventListener("click", () => {
    claimedRound = view.guest?.host?.blind?.round ?? 0;
    act("guestClaim", found);
    render();
  });
}

// Texte de chat, pour l'hôte : un lien YouTube s'ajoute à la playlist d'un clic (＋),
// un timecode (1:23, 1:02:03) amène tout le salon à ce moment
const CHAT_LINKS = /(https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?\S*|shorts\/\S+|live\/\S+|playlist\?\S*)|youtu\.be\/\S+))|\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

function chatText(parent, text) {
  let last = 0;
  for (const m of text.matchAll(CHAT_LINKS)) {
    parent.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      parent.appendChild(el("span", { textContent: m[1], className: "yt" }));
      parent.appendChild(button("＋", () => act("addLink", m[1]), "pill ref")).title = t("addToPlaylistTitle");
      continue;
    }
    const seconds = (Number(m[2] ?? 0) * 60 + Number(m[3])) * 60 + Number(m[4]);
    parent.appendChild(button(m[0], () => act("seek", seconds), "pill ref")).title = t("seekAllTitle");
  }
  parent.append(text.slice(last));
}

// Salons publics : un clic sur une ligne rejoint le salon
function renderPublicRooms() {
  const { list, loading, at } = view.rooms;
  $("#public-refresh").classList.toggle("on", loading);
  $("#public-status").textContent = loading
    ? t("searching")
    : at && !list.length
      ? t("noRooms")
      : t("roomsOpen", list.length);
  $("#public-list").replaceChildren(
    ...view.rooms.list.map((r) => {
      const li = el("li");
      li.title = t("join");
      const name = `${r.mode === "blind" ? "❓" : "🎵"} ${r.code}${r.game ? ` · ${t("gameInProgress")}` : ""}`;
      li.append(el("span", { textContent: name, className: "name" }), el("span", { textContent: `${r.players} 👤`, className: "muted" }));
      li.addEventListener("click", () => {
        commitName();
        act("joinRoom", r.code);
      });
      return li;
    })
  );
}

// --- Fiche d'une personne ------------------------------------------------------
// Clic sur un nom → fiche. Hôte : points en blind test, « Exclure… », « Bannir… ». Invité :
// « Bloquer… » (une autre personne ou l'hôte). Toujours par un panneau qui écrit les
// conséquences (GUIDE.md).

let person = null; // { id, confirm: null | "kick" | "ban" | "block" }

function openPerson(id) {
  person = { id, confirm: null };
  render();
}

function closePerson() {
  person = null;
  render();
}

function renderPerson(blind) {
  const box = $("#person");
  const guest = view.guest;
  const room = view.room ?? (guest?.status === "joined" ? guest : null);
  const known =
    person &&
    room &&
    (person.id === "host"
      ? { id: "host", name: t("host"), code: guest ? guest.hostCode : view.me.code, score: room.hostScore }
      : room.players.find((p) => p.id === person.id && p.id !== guest?.me));
  box.hidden = !known;
  if (!known) {
    person = null;
    return;
  }
  if (person.confirm) {
    const kind = person.confirm;
    const confirm = {
      kind,
      help: kind === "block" && known.id === "host" ? t("blockHostConfirmHelp") : undefined,
      onYes: () => {
        act(kind, known.id);
        closePerson();
      },
      onNo: () => {
        person.confirm = null;
        render();
      },
    };
    box.replaceChildren(...personCard(known, { onClose: closePerson, confirm }));
    return;
  }
  const ask = (kind) => () => {
    person.confirm = kind;
    render();
  };
  const actions = [];
  if (guest) {
    actions.push(askButton("block", ask("block")));
  } else {
    if (blind) actions.push(button("+1", () => act("award", known.id, 1)), button("−1", () => act("award", known.id, -1)));
    if (known.id !== "host") actions.push(askButton("kick", ask("kick")), askButton("ban", ask("ban")));
  }
  box.replaceChildren(...personCard(known, { onClose: closePerson, actions }));
}

// Heure d'envoi (HH:MM), donnée par l'hôte : la même pour tout le salon
function chatTime(msg) {
  if (!Number.isFinite(msg.at)) return null;
  const date = new Date(msg.at);
  return el("time", { textContent: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), dateTime: date.toISOString() });
}

// Ligne de chat, précédée de son heure (GUIDE §3)
function chatLine(msg, options) {
  const p = chatBody(msg, options);
  const time = chatTime(msg);
  if (time) p.prepend(time);
  return p;
}

// Contenu d'une ligne. Hôte : timecodes et vidéos proposées cliquables (pour tout le salon),
// indice « probable », +1, nom cliquable (fiche). Invité : propositions masquées pendant une manche.
function chatBody(msg, { guest, referee, playing }) {
  if (msg.system) return el("p", { textContent: t(msg.key, ...(msg.args ?? [])), className: "msg system" });
  const who = (m) => (m.from === "host" ? t("host") : m.name);
  if (msg.masked) return el("p", { textContent: msg.mine ? t("yourGuess", msg.mine) : t("someoneGuessed", who(msg)), className: "msg masked" });
  // L'hôte joue (onglet Blind test) : pendant la manche, il ne voit que ses propres réponses
  if (playing && msg.private) {
    return el("p", { textContent: msg.from === "host" ? t("yourGuess", msg.text ?? "") : t("someoneGuessed", who(msg)), className: "msg masked" });
  }
  const p = el("p", { className: msg.private ? "msg private" : "msg" });
  if (msg.private) p.append("🔒 ");
  // Nom cliquable (fiche) : chez l'hôte, un invité présent ; chez un invité, l'hôte ou un autre invité
  const clickable = guest
    ? msg.from !== view.guest.me && (msg.from === "host" || view.guest.players.some((x) => x.id === msg.from))
    : msg.from !== "host" && view.room?.players.some((x) => x.id === msg.from);
  // Surligné : seulement son propre pseudo (pas celui d'un joueur parti, non cliquable lui aussi)
  const mine = guest ? msg.from === view.guest.me : msg.from === "host";
  const name = p.appendChild(el("span", { textContent: `${who(msg)} : `, className: mine ? "who me" : "who" }));
  name.title = nameWithCode(who(msg), msg.code);
  if (msg.color) name.style.color = msg.color;
  if (clickable) name.addEventListener("click", () => openPerson(msg.from));
  if (msg.text) {
    if (guest) p.append(msg.text);
    else chatText(p, msg.text);
  }
  // Aide à l'arbitrage : la proposition ressemble au titre
  if (msg.hint) p.appendChild(el("span", { textContent: t("probable"), className: "pill good" })).title = t("probableTitle");
  if (msg.ref) {
    const text = `▶ ${msg.ref.label || t("video")}${msg.ref.start ? ` (${formatTime(msg.ref.start)})` : ""}`;
    p.append(guest ? el("span", { textContent: text, className: "pill ref plain" }) : button(text, () => act("playRef", msg.ref), "pill ref"));
  }
  // Animateur : il donne les points directement depuis une proposition
  if (!guest && referee && msg.from !== "host") p.append(button("+1", () => act("award", msg.from, 1)));
  return p;
}

function guestStatus(g) {
  if (g.status === "connecting") return t("connecting");
  if (g.status === "proof") return view.me.mining ? t("identityMining", view.me.mining.percent) : t("connecting");
  if (g.status === "ended") return t(g.endKey, ...(g.endArgs ?? []));
  return t("players", g.players.length);
}

// Notre salon (hôte) ou celui de quelqu'un d'autre (invité) : même panneau
function renderRoom(blind) {
  const guest = view.guest;
  const room = view.room ?? guest;
  // Le salon s'affiche au-dessus des onglets : les deux lignes, ou le chat une fois dedans
  // À l'ouverture d'un salon, le chat s'affiche ; 🌐 permet ensuite de le replier
  if (room && !hadRoom) roomOpen = true;
  // Après la fermeture, un nouveau nom est proposé (sinon le champ vide montre « Nom du salon »)
  if (!room && hadRoom) $("#room-name").value = suggestName();
  hadRoom = !!room;
  $("#toggle-room").hidden = !view.settings.showMulti && !room;
  $("#toggle-room").classList.toggle("on", roomOpen);

  // Messages des autres : badge de non-lus sur 🌐 quand le chat est replié, son en option
  const me = guest ? guest.me : "host";
  const others = room ? room.chat.filter((m) => !m.system && m.from !== me) : [];
  const latest = others.length ? others[others.length - 1].id : 0;
  if (roomOpen && !$("#main").hidden) lastSeenId = latest;
  const unread = others.filter((m) => m.id > lastSeenId).length;
  $("#unread").hidden = !unread;
  $("#unread").textContent = countText(unread);
  if (latest > lastHeardId) {
    if (lastHeardId && view.settings.chatSound) beep();
    lastHeardId = latest;
  }
  if (!room) lastSeenId = lastHeardId = 0; // un autre salon recommence sa numérotation

  // Premier lancement : identité anti-spam en cours de calcul
  const mining = view.me.mining;
  $("#online").hidden = !roomOpen;
  $("#mining").hidden = !mining || !!room;
  if (mining) {
    $("#mining-title").textContent = t("identityMining", mining.percent);
    $("#mining-bar").value = mining.percent;
  }
  $("#room-panel").hidden = !room;
  $("#room-form").hidden = !!room;
  $("#name-ask").hidden = !!room || view.settings.nameSet;
  if (document.activeElement !== $("#ask-name")) $("#ask-name").value = view.settings.nickname;
  $("#rooms-row").hidden = !!room;
  $("#public-list").hidden = !!room;
  if (!room) {
    person = null;
    $("#person").hidden = true;
    $("#room-go").textContent = listedRoom() ? t("join") : t("create");
    return renderPublicRooms();
  }
  if (room.code === roomName($("#room-name").value)) $("#room-name").value = "";

  $("#room-code").textContent = room.code;
  $("#room-public-badge").hidden = !room.public;
  if (!$("#room-copy").textContent.startsWith("✓")) $("#room-copy").textContent = t("copyLink");
  $("#room-close").title = t(guest ? "leave" : "closeRoom");
  $("#room-status").textContent = guest
    ? guestStatus(guest)
    : room.status === "opening"
      ? t("roomOpening")
      : room.status === "error"
        ? t("connError")
        : t("guests", room.players.length);
  $("#chat-input").placeholder = t(guest ? "guestChatPlaceholder" : "chatPlaceholder");
  $("#chat-input").disabled = !!guest && guest.status !== "joined";

  // Pastilles : couleur, nom, code, score. L'hôte clique sur un nom pour ouvrir sa fiche.
  const scores = guest ? !!guest.host?.blind : blind;
  const hostScore = guest ? guest.host?.hostScore : view.state.mode === "blind" ? room.hostScore : null;
  const hostChip = () =>
    chip(
      { name: t("host"), code: guest ? guest.hostCode : view.me.code },
      { me: !guest, score: hostScore, onClick: () => openPerson("host") }
    );
  $("#room-players").replaceChildren(
    ...(hostScore != null ? [hostChip()] : []),
    ...room.players.map((p) =>
      chip(p, { me: p.id === me, score: scores ? p.score : null, onClick: p.id === me ? null : () => openPerson(p.id) })
    )
  );
  renderPerson(blind);

  const chat = $("#chat");
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  const playing = !guest && view.state.mode === "blind";
  const referee = !guest && view.state.mode === "emcee";
  chat.replaceChildren(...room.chat.map((msg) => chatLine(msg, { guest: !!guest, referee, playing })));

  // Bouton 🔒/💬 devant le champ : en blind test, pour les joueurs (pas pour l'animateur)
  const plays = guest ? !!guest.host?.blind : playing;
  $("#chat-secret").hidden = !plays;
  $("#chat-secret").textContent = secretGuess ? "🔒" : "💬";
  $("#chat-secret").title = t(secretGuess ? "secretOnTitle" : "secretOffTitle");
  $("#chat-secret").classList.toggle("on", secretGuess);
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

// Invité : l'écran suit l'hôte (sa vidéo, son blind test) ; sa playlist sert à proposer dans le chat
function renderGuest(g) {
  const h = g.host;
  const blind = h?.blind;
  const hidden = !!blind && blind.hideVideo && blind.phase !== "revealed";
  const preview = view.settings.showPreview;
  $("#player-wrap").hidden = !preview;
  const art = $("#art");
  art.hidden = !g.videoId || hidden;
  if (!art.hidden) {
    const src = `https://i.ytimg.com/vi/${g.videoId}/mqdefault.jpg`;
    if (art.src !== src) art.src = src;
  }
  $("#show-player").hidden = hidden;
  art.classList.toggle("still", hidden);
  $("#show-player").classList.toggle("on", !!view.playerShown);
  $("#loading").hidden = !view.loading;
  $("#now").classList.toggle("loading", !preview && !!view.loading);
  $("#mask").hidden = !hidden;
  const clipTime =
    blind?.phase === "timeup" ? t("timeUp") : blind?.phase === "playing" && blind.clip ? formatTime(blind.remaining) : "";
  $("#mask-time").textContent = clipTime;
  const clipShown = !!blind && ["playing", "timeup"].includes(blind.phase) && blind.clip > 0;
  progress = clipShown ? { clip: blind.clip, phase: blind.phase, remaining: blind.remaining } : { videoId: hidden ? null : g.videoId };
  renderProgress();
  $("#now").textContent = !blind
    ? h?.title ?? t("guestWaiting")
    : {
        idle: t("blindIdle"),
        loading: t("blindLoading"),
        playing: t("blindPlaying") + (!preview && clipTime ? ` · ${clipTime}` : ""),
        timeup: t("timeUpBang"),
        revealed: t("blindRevealed", blind.answer ?? "?") + (blind.nextIn ? ` · ${t("nextIn", blind.nextIn)}` : ""),
        over: t("gameOver"),
      }[blind.phase] ?? "";
  $("#guest-status").textContent = blind?.total && blind.phase !== "idle" ? t("round", blind.round, blind.total) : "";
  renderHint(blind?.hint ? { mask: blind.hint, max: blind.maxPts } : null);
  $("#guest-claim").hidden = !(blind?.claim && blind.phase === "revealed");
  $("#guest-found").disabled = $("#guest-missed").disabled = claimedRound === blind?.round;
  $("#guest-listen").hidden = !h?.playlist;
  if (!h?.playlist) return;
  $("#share-moment").disabled = !g.videoId;
  if (!changed("guest", h.index, itemsKey(h.playlist))) return;
  $("#guest-queue").replaceChildren(
    ...h.playlist.map((item, i) => {
      const li = el("li", { className: i === h.index ? "current" : "" });
      const row = li.appendChild(el("div", { className: "row" }));
      const key = `guest:${item.id}`;
      if (item.chapters?.length) {
        const open = expanded.has(key);
        row.appendChild(
          button(open ? "▾" : "▸", (e) => {
            e.stopPropagation();
            if (open) expanded.delete(key);
            else expanded.add(key);
            render();
          })
        ).title = t("chapters");
        if (open) {
          const list = li.appendChild(el("ul", { className: "chapters" }));
          for (const c of item.chapters) {
            const crow = list.appendChild(el("li")).appendChild(el("div", { className: "row" }));
            crow.append(el("time", { textContent: formatTime(c.start) }), el("span", { textContent: c.title }));
            crow.title = c.title;
            crow.addEventListener("click", () => act("guestRef", { id: item.id, start: c.start, label: c.title }));
          }
        }
      }
      row.appendChild(el("span", { textContent: item.title })).title = item.title;
      row.addEventListener("click", () => act("guestRef", { id: item.id, start: 0, label: item.title }));
      return li;
    })
  );
}
