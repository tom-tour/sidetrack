// Barre latérale : la vraie page (sidebar.html + common/ + sidebar.js) dans jsdom 24.1.3,
// reliée à de vrais moteurs. Lancer : node tests/sidebar.test.cjs
const { read, until, check, done, makeEngine, sidebarFor, playlist } = require("./harness.cjs");

(async () => {
  try {
    // --- Ce que le kit impose à la page ---
    const html = read("sidebar.html");
    const css = read("sidebar.css");
    check("common/theme.css lié avant sidebar.css", html.indexOf("common/theme.css") > 0 && html.indexOf("common/theme.css") < html.indexOf("sidebar.css"));
    const order = ["common/i18n-core.js", "i18n.js", "common/ui.js", "sidebar.js"].map((f) => html.indexOf(`src="${f}"`));
    check("scripts : i18n-core, i18n.js, ui.js, puis la page", order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), JSON.stringify(order));
    check("sidebar.css ne redéfinit ni couleurs ni composants du kit", !/:root|--bg:|^\s*\.(tab|tabs|notice|chip|chips|card|settings|badge|icon|line|muted)\b/m.test(css));
    check("i18n.js : seulement les textes de Sidetrack", !/function (t|setLang|applyI18n)\b/.test(read("i18n.js")));

    const host = makeEngine("hôte", { sidetrack: playlist, settings: { nickname: "Hôtesse" } });
    const bob = makeEngine("bob", { settings: { nickname: "Bob" } });
    await until(() => host.snap()?.me.code && bob.snap()?.me.code, 10000);
    const sb = sidebarFor(host);
    await until(() => sb.$("#pl-select").options.length > 0);
    const { $, $$ } = sb;

    // --- Réglages : cadres dans l'ordre du guide ---
    sb.click("#open-settings");
    const legends = $$("#settings > fieldset > legend").map((l) => l.textContent);
    check("cadres : Général, Affichage, Multijoueur, Sauvegarde, Profil, Personnes bloquées, Personnes bannies, À propos", legends.join(" | ") === "Général | Affichage | Multijoueur | Sauvegarde | Profil | Personnes bloquées | Personnes bannies | À propos", legends.join(" | "));
    const kids = [...$("#settings").children].map((e) => e.tagName);
    check("Journal repliable juste avant À propos (en dernier)", kids.at(-2) === "DETAILS" && kids.at(-1) === "FIELDSET" && $("#settings").classList.contains("settings"));
    check("son des messages dans Général (texte commun)", $$("#settings fieldset")[0].textContent.includes("Son à chaque nouveau message"));
    check("cases à cocher en label.check", $$("#settings input[type=checkbox]").every((c) => c.closest("label").classList.contains("check")));
    check("Profil : pseudo, ton code, avertissement IP", $("#my-code").textContent === host.snap().me.code && $$("#settings fieldset")[4].textContent.includes("adresse IP"));
    sb.click("#close-settings");

    // --- Onglets : style du kit ---
    check("onglets : conteneur .tabs, boutons .tab", $("#tabs").classList.contains("tabs") && $$("#tabs .tab").length === 3);

    // --- Supprimer une playlist : « Sûr ? » (createSure) ---
    host.act("createPlaylist", "À jeter");
    await until(() => host.snap().state.playlists.length === 2);
    sb.click("#pl-delete");
    await until(() => $("#pl-delete").textContent === "Sûr ?");
    check("premier clic : « Sûr ? » en rouge", $("#pl-delete").textContent === "Sûr ?" && $("#pl-delete").classList.contains("danger"));
    sb.click("#pl-delete");
    await until(() => host.snap().state.playlists.length === 1);
    check("second clic : playlist supprimée", host.snap().state.playlists.length === 1 && $("#pl-delete").textContent === "🗑");

    // --- Salon : pastilles avec code, nom du chat avec code en infobulle ---
    host.act("openRoom", { name: "barre" });
    await until(() => host.snap()?.room?.status === "open");
    bob.act("joinRoom", "barre");
    await until(() => host.snap().room?.players.length === 1, 5000);
    await until(() => $$("#room-players .chip").length === 1);
    const chip = $("#room-players .chip");
    check("pastille : nom et code d'identité", chip.textContent.includes("Bob") && chip.querySelector(".code").textContent === bob.snap().me.code);
    bob.act("guestChat", "coucou");
    await until(() => $$("#chat .msg").some((p) => p.textContent.includes("coucou")));
    const line = $$("#chat .msg").find((p) => p.textContent.includes("coucou"));
    check("chat : infobulle « Nom · CODE »", line.querySelector(".who").title === `Bob · ${bob.snap().me.code}`);
    check("chat : heure HH:MM en tête de ligne", line.firstChild.nodeName === "TIME" && /^\d{1,2}:\d{2}/.test(line.firstChild.textContent), line.firstChild.textContent);
    check("chat : nom d'un invité ni surligné ni « moi »", !line.querySelector(".who").classList.contains("me"));
    // L'hôte écrit : son pseudo surligné ; trop vite : bandeau et texte gardé
    for (const text of ["un", "deux", "trois"]) {
      $("#chat-input").value = text;
      $("#chat-form").dispatchEvent(new sb.win.Event("submit", { cancelable: true }));
    }
    await until(() => $$("#chat .msg").some((p) => p.textContent.includes("un")) && !$("#notice").hidden);
    const mineLine = $$("#chat .msg").find((p) => p.textContent.endsWith(" : un"));
    check("chat : son propre pseudo surligné (.who.me)", mineLine?.querySelector(".who.me")?.textContent === "Hôte : ");
    check("hôte trop rapide : bandeau « Doucement : 2 messages par seconde au plus. »", $("#notice").textContent.includes("Doucement : 2 messages par seconde au plus."), $("#notice").textContent);
    await until(() => $("#chat-input").value === "trois");
    check("hôte trop rapide : texte gardé dans le champ", $("#chat-input").value === "trois");
    $("#chat-input").value = "";
    check("pas de boutons d'exclusion au survol", !$("#room-players .mod") && !$$("#room-players button").some((b) => /✕|🚫/.test(b.textContent)));

    // --- Bannir : nom → fiche → « Bannir… » → panneau qui écrit les conséquences ---
    sb.click(line.querySelector(".who"));
    await until(() => !$("#person").hidden);
    check("clic sur le nom : fiche avec nom et code", !$("#person").hidden && $("#person .head").textContent.includes("Bob") && $("#person .code").textContent === bob.snap().me.code);
    const banAsk = $$("#person button").find((b) => b.textContent.includes("Bannir"));
    sb.click(banAsk);
    await until(() => $("#person .warn"));
    check("panneau de confirmation : conséquences écrites", $("#person .warn").textContent === "Bannir Bob ?" && $("#person").textContent.includes("ne pourra plus entrer"));
    const cancel = $$("#person button").find((b) => b.textContent === "Annuler");
    sb.click(cancel);
    await until(() => !$("#person .warn"));
    check("Annuler : retour à la fiche, personne n'est banni", !$("#person .warn") && host.snap().room.players.length === 1);
    sb.click($$("#person button").find((b) => b.textContent.includes("Bannir")));
    await until(() => $("#person .warn"));
    const confirm = $$("#person button").find((b) => b.textContent === "Bannir Bob");
    check("bouton de confirmation rouge « Bannir Bob »", confirm?.classList.contains("danger"));
    sb.click(confirm);
    await until(() => !host.snap().room.players.length, 3000);
    check("Bob banni et sorti du salon", !host.snap().room.players.length);
    sb.click("#open-settings");
    await until(() => $("#banned li span")?.textContent.includes("·"));
    check("liste des bannis : « Bob · CODE » et Débannir", $("#banned li span").textContent === `Bob · ${bob.snap().me.code}` && $("#banned li button").textContent === "Débannir");
    sb.click("#banned li button");
    await until(() => !Object.keys(host.snap().settings.banned).length);
    check("Débannir", !Object.keys(host.snap().settings.banned).length && $("#banned li").textContent === "Personne n'est banni.");
    sb.click("#close-settings");

    // --- Bloquer, chez un invité : nom → fiche → « Bloquer… » → conséquences → confirmer ---
    const carol = makeEngine("carol", { settings: { nickname: "Carol" } });
    await until(() => carol.snap()?.me.code, 10000);
    bob.act("leaveRoom");
    bob.act("joinRoom", "barre");
    carol.act("joinRoom", "barre");
    await until(() => carol.snap()?.guest?.players.length === 2, 5000);
    check("débanni : Bob peut revenir dans le salon ouvert", bob.snap().guest.status === "joined");
    const cb = sidebarFor(carol);
    await until(() => cb.$$("#room-players .chip").length === 2);
    await until(() => false, 1100);
    bob.act("guestChat", "salut Carol", false);
    await until(() => cb.$$("#chat .msg").some((p) => p.textContent.includes("salut Carol")));
    const bobLine = cb.$$("#chat .msg").find((p) => p.textContent.includes("salut Carol"));
    check("invité : nom d'un autre invité cliquable", bobLine.querySelector(".who").classList.contains("who") && !bobLine.querySelector(".who").classList.contains("me"));
    cb.click(bobLine.querySelector(".who"));
    await until(() => !cb.$("#person").hidden);
    const blockAsk = cb.$$("#person button").find((b) => b.textContent.includes("Bloquer"));
    check("fiche d'invité : « ⛔ Bloquer… » seulement", blockAsk?.textContent === "⛔ Bloquer…" && !cb.$$("#person button").some((b) => /Bannir|Exclure|\+1/.test(b.textContent)));
    cb.click(blockAsk);
    await until(() => cb.$("#person .warn"));
    check("conséquences écrites, dont ce que sait l'hôte", cb.$("#person .warn").textContent === "Bloquer Bob ?" && cb.$("#person").textContent.includes("L'hôte du salon saura"));
    const yes = cb.$$("#person button").find((b) => b.textContent === "Bloquer Bob");
    check("bouton rouge « Bloquer Bob »", yes?.classList.contains("danger"));
    cb.click(yes);
    await until(() => cb.$$("#room-players .chip").length === 1 && !cb.$$("#chat .msg").some((p) => p.textContent.includes("salut Carol")), 3000);
    check("Bob disparaît des pastilles et du chat de Carol", cb.$$("#room-players .chip").length === 1);
    cb.click("#open-settings");
    await until(() => cb.$("#blocked li span")?.textContent.includes("·"));
    check("liste des bloqués : « Bob · CODE » et Débloquer", cb.$("#blocked li span").textContent === `Bob · ${bob.snap().me.code}` && cb.$("#blocked li button").textContent === "Débloquer");
    cb.click("#blocked li button");
    await until(() => !Object.keys(carol.snap().settings.blocked).length);
    check("Débloquer", cb.$("#blocked li").textContent === "Personne n'est bloqué.");
    cb.click("#close-settings");
    carol.act("guestChat", "au revoir", false);
    await until(() => $$("#chat .msg").some((p) => p.textContent.includes("au revoir")));
    carol.act("leaveRoom");
    await until(() => !host.snap().room.players.some((p) => p.name === "Carol"), 3000);
    await until(() => !$$("#chat .msg").find((p) => p.textContent.includes("au revoir"))?.querySelector(".who").classList.contains("me"));
    const goneLine = $$("#chat .msg").find((p) => p.textContent.includes("au revoir"));
    check("joueur parti : nom ni surligné ni cliquable", goneLine && !goneLine.querySelector(".who").classList.contains("me"));

    // --- Réglages : envoyés au moteur et nettoyés ---
    sb.click("#open-settings");
    $("#set-chatSound").checked = true;
    sb.fire("#set-chatSound", "change");
    $("#set-nickname").value = "  Nouvelle   hôtesse ";
    sb.fire("#set-nickname", "change");
    await until(() => host.snap().settings.nickname === "Nouvelle hôtesse" && host.snap().settings.chatSound);
    check("réglages transmis (et pseudo nettoyé)", host.snap().settings.chatSound === true && host.snap().settings.nickname === "Nouvelle hôtesse");
    $("#set-lang").value = "en";
    sb.fire("#set-lang", "change");
    await until(() => $("#close-settings").textContent === "← Back");
    check("langue changée : textes communs et propres retraduits", $$("#settings legend")[0].textContent === "General" && $$("#settings legend")[5].textContent === "Blocked people" && $$("#settings legend")[6].textContent === "Banned people");

    // --- Première identité : barre de progression ---
    const fresh = makeEngine("neuve", {});
    const sf = sidebarFor(fresh);
    fresh.eval("myIdentity.mining = { tries: 3 }; update()");
    await until(() => sf.$("#mining-title")?.textContent.includes("%"));
    sf.click("#toggle-room");
    await until(() => !sf.$("#mining").hidden);
    check("identité en calcul : « Création de l'identité anti-spam… N % »", /Création de l'identité anti-spam… \d+ %/.test(sf.$("#mining-title").textContent), sf.$("#mining-title").textContent);

    // --- Premier salon : choix du pseudo ---
    check("pseudo déjà choisi : rien n'est proposé", bob.snap().settings.nameSet === true);
    await until(() => fresh.snap()?.settings.nickname && sf.$("#ask-name").value);
    check("sans pseudo : proposé au-dessus du salon", !sf.$("#name-ask").hidden && sf.$("#name-ask label").textContent === "Pseudo" && /^Invité-\d{4}$/.test(sf.$("#ask-name").value) && sf.$("#ask-name").value === fresh.snap().settings.nickname && sf.$("#name-ask button").textContent === "OK");
    sf.$("#ask-name").value = "Zoé";
    sf.$("#name-ask").requestSubmit();
    await until(() => fresh.snap().settings.nameSet);
    check("OK garde le pseudo tapé", fresh.snap().settings.nickname === "Zoé");
    await until(() => sf.$("#name-ask").hidden);
    check("plus proposé ensuite", sf.$("#name-ask").hidden);
    const legacy = makeEngine("ancien", { settings: { nickname: "Invité-1234" } });
    await until(() => legacy.snap()?.settings.nickname);
    check("pseudo proposé d'avant : toujours proposé", legacy.snap().settings.nameSet === false && legacy.snap().settings.nickname === "Invité-1234");
    const quiet = makeEngine("calme", {});
    const sq = sidebarFor(quiet);
    await until(() => quiet.snap()?.me.code);
    sq.click("#toggle-room");
    await until(() => !sq.$("#name-ask").hidden);
    sq.$("#room-form").requestSubmit();
    await until(() => quiet.snap().settings.nameSet);
    check("entrer dans un salon sans y toucher : « Invité-1234 » accepté", /^Invité-\d{4}$/.test(quiet.snap().settings.nickname) && quiet.snap().settings.nameSet);

    // --- Premiers pas : autorisation, « prêt », conseils, ranger l'onglet ---
    const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const first = makeEngine("premiers pas", { sidetrack: playlist });
    const s1 = sidebarFor(first, "fr-FR", { url: VIDEO });
    await until(() => first.player.port && first.snap());
    first.fromPlayer({ type: "hello", autoplay: "disallowed" });
    await until(() => !s1.$("#notice").hidden);
    const noticeButtons = [...s1.$("#notice .actions").children].map((b) => b.textContent);
    check("autorisation attendue : seulement « Aller à l'onglet », pas de OK", noticeButtons.join("|") === "Aller à l'onglet", noticeButtons.join("|"));
    check("bandeau : nom du nouveau bouton", s1.$("#notice").textContent.includes("« Autoriser Sidetrack à lire des vidéos dans cet onglet »"));
    check("la page du lecteur demandera de ranger l'onglet (première fois)", first.player.cmds.some((c) => c.action === "setup" && c.askHide === true));
    check("pas de halo avant l'autorisation", !s1.$$(".beckon").length);
    first.fromPlayer({ type: "unblocked", asking: true });
    await until(() => s1.$("#notice").hidden && !s1.$("#ready").hidden && !s1.$("#tips").hidden);
    check("autorisé : bandeau parti, « prêt » et conseils affichés", s1.$("#ready").textContent.includes("Sidetrack est prêt") && s1.$("#tips").textContent.includes("Pour commencer"));
    check("conseils : OK et « Ne plus afficher »", s1.$("#tips-ok").textContent === "OK" && s1.$("#tips-never").textContent === "Ne plus afficher");
    check("halo sur le champ du lien, 📚 et 🌐", ["#url", "#pl-presets", "#toggle-room"].every((id) => s1.$(id).classList.contains("beckon")), s1.$$(".beckon").map((e) => e.id).join(","));
    first.fromPlayer({ type: "hideChoice", hide: false });
    await until(() => first.snap().settings.tabAsked);
    check("onglet gardé visible : réglage décoché et plus redemandé", first.snap().settings.hideTab === false && first.store.settings.tabAsked === true);
    first.fromPlayer({ type: "blocked" });
    await until(() => !s1.$("#notice").hidden);
    s1.click("#tips-never");
    await until(() => s1.$("#tips").hidden);
    check("Ne plus afficher : conseils fermés, halos éteints, réglage décoché", !s1.$$(".beckon").length && first.snap().settings.showTips === false);
    first.fromPlayer({ type: "unblocked" });
    await until(() => s1.$("#notice").hidden);
    check("nouvelle autorisation dans la session : pas de nouveaux conseils", s1.$("#tips").hidden);
    await until(() => s1.$("#ready").hidden, 7000);
    check("« prêt » disparaît seul après 5 s", s1.$("#ready").hidden);
    s1.click("#open-settings");
    s1.click("#set-showTips");
    await until(() => !s1.$("#tips").hidden);
    check("case recochée : les conseils reviennent", first.snap().settings.showTips === true);
    s1.click("#close-settings");

    // --- Aperçu : désactivé par défaut, réglage pour le remettre ---
    check("aperçu masqué par défaut", s1.$("#player-wrap").hidden && first.snap().settings.showPreview === false);
    first.act("setSetting", "showPreview", true);
    await until(() => !s1.$("#player-wrap").hidden);
    check("réglage : aperçu affiché", !s1.$("#player-wrap").hidden);
    check("plus de texte « vidéos officielles » dans les playlists toutes prêtes", !read("sidebar.html").includes("presetsHelp") && !s1.$("#presets").textContent.includes("officielles"));

    // --- Progression : la vidéo partout, l'extrait pendant une manche ---
    const firstItem = first.snap().state.playlists.find((p) => p.id === first.snap().state.current).items[0];
    first.act("play", 0);
    first.fromPlayer({ type: "tick", id: firstItem.id, time: 30, duration: 200, state: 1 });
    await until(() => !s1.$("#progress").hidden);
    check("lecture : progression « 0:30 / 3:20 »", s1.$("#pos-time").textContent === "0:30" && s1.$("#pos-total").textContent === "3:20", `${s1.$("#pos-time").textContent} / ${s1.$("#pos-total").textContent}`);
    await until(() => s1.$("#pos-time").textContent === "0:31", 2000);
    check("la position avance seule entre deux états du moteur", s1.$("#pos-time").textContent === "0:31");
    first.fromPlayer({ type: "tick", id: firstItem.id, time: 31.2, duration: 200, state: 1 });
    first.fromPlayer({ type: "tick", id: firstItem.id, time: 32.2, duration: 200, state: 1 });
    s1.$("#pos-bar").getBoundingClientRect = () => ({ left: 0, width: 100 });
    s1.$("#pos-bar").dispatchEvent(new s1.win.MouseEvent("click", { bubbles: true, clientX: 50 }));
    await until(() => first.player.cmds.some((c) => c.action === "seek"));
    check("clic au milieu de la barre : saut à 1:40", first.player.cmds.find((c) => c.action === "seek")?.time === 100);
    first.eval("resetGame(); state.mode = 'blind'; Object.assign(game, { phase: 'playing', order: [{ i: 0 }], pos: 0, clip: 20, remaining: 12 }); update()");
    await until(() => s1.$("#pos-total").textContent === "0:20");
    check("manche : extrait « 0:08 / 0:20 », pas de saut", s1.$("#pos-time").textContent === "0:08" && !s1.$("#progress").classList.contains("seek"));
    first.eval("resetGame(); state.mode = 'listen'; update()");
    await until(() => s1.$("#pos-total").textContent === "3:20");

    // --- Lien de l'onglet actif dans le champ ---
    check("onglet YouTube actif : champ rempli", s1.$("#url").value === VIDEO, s1.$("#url").value);
    s1.setTab("https://example.org/");
    await until(() => s1.$("#url").value === "");
    check("onglet quitté : lien retiré (champ pas modifié)", s1.$("#url").value === "");
    const LIST = "https://www.youtube.com/playlist?list=PL123";
    s1.setTab(LIST, { navigate: true });
    await until(() => s1.$("#url").value === LIST);
    check("navigation vers une playlist : champ rempli", s1.$("#url").value === LIST);
    s1.$("#add").requestSubmit();
    await new Promise((r) => setTimeout(r, 50));
    s1.setTab(LIST);
    await new Promise((r) => setTimeout(r, 50));
    check("lien ajouté : pas reproposé", s1.$("#url").value === "", s1.$("#url").value);
    s1.$("#url").value = "ma recherche";
    s1.setTab(VIDEO);
    await new Promise((r) => setTimeout(r, 50));
    check("champ modifié à la main : pas écrasé", s1.$("#url").value === "ma recherche");

    // --- Playlist et Blind test séparés : chaque onglet son haut de page, ses playlists ---
    const two = {
      playlists: [
        playlist.playlists[0],
        { id: "p2", name: "Animes", items: [{ id: "abcdefghijk", title: "Opening A", chapters: [] }, { id: "9bZkp7q19f0", title: "PSY - Gangnam Style", chapters: [] }] },
      ],
      current: "p1",
    };
    const sep = makeEngine("séparés", { sidetrack: two });
    const s2 = sidebarFor(sep);
    await until(() => sep.snap() && s2.$("#pl-select").options.length === 2);
    check("onglets en haut, avec 🌐 et ⚙ sur la même ligne", s2.$("#top").contains(s2.$("#tabs")) && s2.$("#top").contains(s2.$("#open-settings")) && s2.$("#top").contains(s2.$("#toggle-room")));
    check("Playlist : barre des playlists et champ du lien visibles", !s2.$("#listen-head").hidden && s2.$("#blind-setup").hidden);
    s2.click("#mode-blind");
    await until(() => !s2.$("#blind-setup").hidden);
    check("Blind test : ni barre des playlists ni champ du lien", s2.$("#listen-head").hidden);
    const boxes = () => s2.$$("#blind-sources input");
    check("une case par playlist, la playlist ouverte cochée par défaut", boxes().length === 2 && boxes()[0].checked && !boxes()[1].checked);
    check("réglages résumés en une ligne", s2.$("#blind-summary").textContent === "⚙ Durée du chapitre · chapitre aléatoire · indices · pause 10 s", s2.$("#blind-summary").textContent);
    boxes()[1].checked = true;
    s2.fire(boxes()[1], "change");
    await until(() => sep.snap().state.blindSources.length === 2);
    check("deux playlists cochées : 3 morceaux (doublon compté une fois)", sep.snap().deck.length === 3 && s2.$("#blind-status").textContent === "3 morceau(x) à jouer.", s2.$("#blind-status").textContent);
    sep.act("setBlind", "startMode", "start");
    sep.act("startGame");
    await until(() => sep.snap().game.phase === "playing");
    const loaded = sep.player.cmds.filter((c) => c.action === "load").at(-1);
    check("la partie joue une piste des playlists cochées", ["dQw4w9WgXcQ", "9bZkp7q19f0", "abcdefghijk"].includes(loaded?.id) && sep.snap().game.order.length === 3);
    check("la partie ne touche pas à la playlist ouverte", sep.snap().state.current === "p1" && sep.snap().state.index === -1);
    await until(() => s2.$("#blind-setup").hidden);
    check("pendant la partie : réglages et playlists repliés", s2.$("#blind-setup").hidden && s2.$("#now").textContent.startsWith("Morceau mystère"));
    sep.act("reveal");
    await until(() => s2.$("#now").textContent === sep.snap().current.title);
    check("révélé : le titre de la piste jouée", s2.$("#now").textContent === sep.snap().current.title && sep.snap().current.id === loaded.id);
    check("stockage : playlists jouées gardées", JSON.stringify(sep.store.sidetrack.blindSources) === JSON.stringify(["p1", "p2"]));

    // --- Blind test pratique : formules, manches, réécouter, onglets, raccourcis, récapitulatif ---
    const bt = makeEngine("blind pratique", { sidetrack: { ...two, blindSources: ["p1", "p2"] } });
    const s3 = sidebarFor(bt);
    await until(() => bt.snap() && s3.$("#pl-select").options.length === 2);
    s3.click("#mode-blind");
    await until(() => !s3.$("#blind-setup").hidden);
    check("réglages en trois groupes", s3.$$("#blind-settings .group").map((g) => g.textContent).join("|") === "Manches|Pendant la manche|Après la réponse");
    s3.click('#formulas [data-formula="express"]');
    await until(() => bt.snap().settings.blind.rounds === 10);
    const bs = bt.snap().settings.blind;
    check("formule Express : 10 manches, 15 s, moment aléatoire, 5 s", bs.clip === 15 && bs.startMode === "random" && bs.pause === 5);
    await until(() => s3.$('#formulas [data-formula="express"]').classList.contains("on"));
    check("formule en cours allumée, résumé avec les manches", s3.$("#blind-summary").textContent.startsWith("⚙ 10 manches · 15 s · moment aléatoire"), s3.$("#blind-summary").textContent);
    check("« après 5 s » dans la liste de la manche suivante", s3.$('#pause option[value="5"]').textContent === "après 5 s");
    s3.$("#rounds").value = "5";
    s3.fire("#rounds", "change");
    await until(() => bt.snap().settings.blind.rounds === 5);
    check("liste « Nombre de manches » : 5", bt.snap().settings.blind.rounds === 5);
    bt.act("setBlind", "rounds", 2);
    bt.act("setBlind", "pause", 0);
    await until(() => bt.snap().settings.blind.rounds === 2 && bt.snap().settings.blind.pause === 0);
    s3.click("#blind-actions button");
    await until(() => bt.snap().game.phase === "playing");
    check("2 manches sur 3 morceaux", bt.snap().game.order.length === 2);
    bt.fromPlayer({ type: "started", duration: 200, time: 42 });
    await until(() => [...s3.$$("#blind-actions button")].some((b) => b.textContent === "↺ Réécouter"));
    s3.click([...s3.$$("#blind-actions button")].find((b) => b.textContent === "↺ Réécouter"));
    await until(() => bt.player.cmds.some((c) => c.action === "seek" && c.time === 42));
    check("↺ Réécouter : retour au début de l'extrait (42 s)", bt.player.cmds.some((c) => c.action === "seek" && c.time === 42));

    // Aller voir les playlists ne coupe pas la partie
    s3.click("#mode-listen");
    await until(() => !s3.$("#listen-head").hidden);
    check("onglet Playlist pendant la partie : partie gardée", bt.snap().state.mode === "blind" && bt.snap().game.phase === "playing" && s3.$("#mode-listen").classList.contains("on"));
    check("bandeau « Partie de blind test en cours · Manche 1/2 »", !s3.$("#game-banner").hidden && s3.$("#game-banner-text").textContent === "❓ Partie de blind test en cours · Manche 1/2", s3.$("#game-banner-text").textContent);
    check("lecture verrouillée dans l'onglet Playlist", s3.$("#toggle").disabled && s3.$("#prev").disabled && s3.$("#queue").classList.contains("locked"));
    check("titre toujours caché dans l'onglet Playlist", s3.$("#now").textContent.startsWith("Morceau mystère"));
    const loads = bt.player.cmds.filter((c) => c.action === "load").length;
    bt.act("play", 0);
    await new Promise((r) => setTimeout(r, 100));
    check("le moteur refuse aussi de lancer un morceau par-dessus la partie", bt.player.cmds.filter((c) => c.action === "load").length === loads && bt.snap().game.phase === "playing");
    s3.click("#game-back");
    await until(() => !s3.$("#blind").hidden);
    check("« Revenir à la partie »", s3.$("#mode-blind").classList.contains("on") && s3.$("#listen-head").hidden);

    // Raccourcis : Espace révèle, puis passe à la manche suivante
    const space = () => s3.win.document.dispatchEvent(new s3.win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    space();
    await until(() => bt.snap().game.phase === "revealed");
    check("Espace : réponse révélée", bt.snap().game.phase === "revealed");
    const firstRound = bt.snap().game.order[0];
    space();
    await until(() => bt.snap().game.pos === 1);
    check("Espace : manche suivante", bt.snap().game.pos === 1);
    bt.act("reveal");
    await until(() => bt.snap().game.phase === "revealed");
    bt.act("nextRound");
    await until(() => bt.snap().game.phase === "over");
    await until(() => !s3.$("#recap").hidden);
    check("fin : récapitulatif des 2 manches, points écrits", s3.$$("#recap-list li").length === 2 && s3.$$("#recap-list li b")[0]?.textContent === "+0", s3.$("#recap-list").textContent);
    const before = bt.player.cmds.length;
    s3.click(s3.$$("#recap-list .row")[0]);
    await until(() => bt.player.cmds.length > before);
    const replayed = bt.player.cmds.slice(before).find((c) => c.action === "load");
    check("clic sur une manche : réécoute au moment entendu", replayed?.start === 42, JSON.stringify(replayed));
    const played = bt.snap().state.blindPlayed;
    check("manches jouées retenues", played.length === 2);
    s3.click("#blind-actions button");
    await until(() => bt.snap().game.phase === "playing");
    const third = bt.snap().game.order[0];
    const key = (r) => (r.chapter == null ? bt.snap().deck[r.i].id : `${bt.snap().deck[r.i].id}:${r.chapter}`);
    check("partie suivante : le morceau pas encore joué d'abord", !played.includes(key(third)), `${key(third)} / ${played}`);

    // Arrêter depuis l'onglet Playlist
    s3.click("#mode-listen");
    await until(() => !s3.$("#game-banner").hidden);
    s3.click("#game-stop");
    await until(() => bt.snap().game.phase === "idle" && bt.snap().state.mode === "listen");
    await until(() => s3.$("#game-banner").hidden);
    check("Arrêter la partie : retour au mode Playlist", !s3.$("#toggle").disabled && s3.$("#mode-listen").classList.contains("on"));

    const errs = [...sb.errors, ...sf.errors, ...sq.errors, ...s1.errors, ...s2.errors, ...s3.errors];
    check("aucune erreur dans la page", !errs.length, errs.join(" / "));
  } catch (err) {
    check("exception", false, err.stack);
  }
  done();
})();
