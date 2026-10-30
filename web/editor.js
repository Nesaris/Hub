// Éditeur de workflows : canevas, palette, paramètres, exécutions.
import { I } from './icons.js';
import { $, $$, html, poser, GET, POST, PUT, DEL, toast, fail, modal, confirmBox, formulaire, readForm, bindDynamic, when, hhmm, exTag, originChip } from './lib.js';

const NODE_W = 216;

/* Un graphe venu d'ailleurs (IA, import) peut avoir des positions absentes,
   « NaN », ou collées au bord gauche — sous la palette, invisibles. On les
   rend lisibles à l'affichage : chiffres valides, et tout décalé pour
   commencer à droite de la palette. Rien n'est marqué modifié. */
function recaler(g) {
  const ns = g?.nodes || [];
  ns.forEach((n, i) => { n.x = Number.isFinite(Number(n.x)) ? Number(n.x) : 380 + i * 280; n.y = Number.isFinite(Number(n.y)) ? Number(n.y) : 200; });
  if (!ns.length) return g;
  const dx = Math.max(0, 340 - Math.min(...ns.map(n => n.x))), dy = Math.max(0, 60 - Math.min(...ns.map(n => n.y)));
  if (dx || dy) ns.forEach(n => { n.x += dx; n.y += dy; });
  return g;
}
const KIND = { trigger: 'Déclencheur', service: 'Service', ai: 'IA', logic: 'Logique', data: 'Données', net: 'Réseau', out: 'Sortie' };

export async function openEditor(stage, wfId, app) {
  // La palette ouverte d'emblée sur un écran large ; sur un téléphone, elle couvrirait le plan.
  const E = { wfId, sel: null, selEdge: null, arm: null, zoom: 1, dirty: false, palOpen: matchMedia('(min-width: 761px)').matches, panel: null, q: '', shut: {}, exec: null, execs: [], tab: 'params', problems: [] };
  const [wf, pal] = await Promise.all([GET(`/api/workflows/${wfId}`), GET('/api/palette')]);
  E.wf = wf; E.pal = pal; E.graph = recaler(structuredClone(wf.graph)); E.name = wf.name; E.problems = wf.problems;
  const lookups = { instances: pal.services, workflows: pal.workflows.filter(w => w.id !== wfId), ai: pal.ai };

  // Définitions
  const coreDef = type => pal.core.find(c => c.type === type);
  const svc = id => pal.services.find(s => s.id === id);
  function defOf(n) {
    if (n.type === 'trigger.service' || n.type === 'service.action') {
      const s = svc(n.instanceId);
      const d = s && (n.type === 'trigger.service' ? s.triggers : s.actions).find(x => x.id === n.ref);
      if (!d) return { name: n.name, params: [], cat: n.type === 'trigger.service' ? 'trigger' : 'service', icon: 'alert', missing: true, trigger: n.type === 'trigger.service' };
      return { ...d, cat: n.type === 'trigger.service' ? 'trigger' : 'service', trigger: n.type === 'trigger.service', service: s };
    }
    if (n.type === 'core.link') return { name: 'Lien de capacité', cat: 'logic', icon: 'pair', params: [], passive: true };
    return coreDef(n.type) || { name: n.type, params: [], cat: 'logic', icon: 'alert', missing: true };
  }
  function outputsOf(n) {
    const p = n.params || {};
    let o = ['main'];
    if (n.type === 'logic.if') o = ['true', 'false'];
    else if (n.type === 'logic.approval') o = ['approved', 'rejected'];
    else if (n.type === 'logic.switch') o = [...String(p.cases ?? 'critique, haute').split(',').map(s => s.trim()).filter(Boolean), 'autre'];
    else if (n.type === 'ai.classify') o = [...String(p.categories ?? 'incident, information, bruit').split(',').map(s => s.trim()).filter(Boolean), 'autre'];
    if (p._onError === 'branch') o = [...o, 'error'];
    return o;
  }
  const PORT_LABEL = { true: 'oui', false: 'non', approved: 'accord', rejected: 'refus', error: 'erreur' };
  const tileCls = d => (d.cat === 'trigger' ? 'key' : d.cat === 'ai' ? 'ink' : '');
  const byId = id => E.graph.nodes.find(n => n.id === id);
  const uid = () => 'n' + Math.random().toString(36).slice(2, 8);
  const markDirty = () => { E.dirty = true; const d = $('#dirty'); if (d) d.classList.remove('hidden'); };

  // Rendu
  function render() {
    const keep = $('#cvw') ? [$('#cvw').scrollLeft, $('#cvw').scrollTop] : null;
    const palScroll = $('#palList')?.scrollTop || 0;
    poser(stage, html`
      <div class="edbar">
        <button class="btn flat sm" id="eBack" aria-label="Retour aux workflows">${I('back', 15)}</button>
        <input class="nm" id="wfName" size=${Math.max(10, E.name.length + 1)} value=${E.name} aria-label="Nom du workflow">
        ${originChip(E.wf.origin)}
        <span class="meta">${E.graph.nodes.length} nœuds · ${E.graph.edges.length} liens · v${E.wf.version}</span>
        <span id="dirty" class="dirty ${E.dirty ? '' : 'hidden'}" title="Modifications non enregistrées"></span>
        <span class="sp"></span>
        <div class="edoutils" role="toolbar" aria-label="Affichage"><div class="zoom"><button id="zOut" aria-label="Dézoomer">${I('minus', 14)}</button><span>${Math.round(E.zoom * 100)} %</span><button id="zIn" aria-label="Zoomer">${I('plus', 14)}</button><button id="zFit" aria-label="Tout afficher">${I('fit', 14)}</button></div>
        <button class="btn sm" id="palTog" aria-label=${E.palOpen ? 'Masquer la palette' : 'Afficher la palette'}>${I('panel', 14)}<span class="etiq">${E.palOpen ? 'Masquer' : 'Nœuds'}</span></button>
        <button class="btn sm" id="runsTog" aria-label="Exécutions">${I('logs', 14)}<span class="etiq">Exécutions</span></button>
        <button class="btn sm" id="more" aria-label="Plus d’actions">•••</button></div>
        <div class="edact" role="toolbar" aria-label="Workflow"><button class="btn sm" id="enable"><span class="toggle ${E.wf.enabled ? 'on' : ''}"><i></i></span>${E.wf.enabled ? 'Actif' : 'Coupé'}</button>
        <button class="btn sm" id="save">${I('check', 13)}Enregistrer</button>
        <button class="btn solid sm" id="run">${I('play', 13)}Tester</button></div>
      </div>
      ${E.problems?.length ? html`<div class="problems ed-problemes"><b>À corriger avant d’activer</b>${E.problems.map((p, i) => html`${i ? html`<br>` : ''}${p.message}${p.fix === 'noms' ? html` <button class="btn sm" id="fixNoms">Renommer pour moi</button>` : ''}`)}</div>` : ''}
      <div class="edbody" id="edbody">
        <div class="planwrap" id="cvw"><div class="sizer" style="width:${3400 * E.zoom}px;height:${2000 * E.zoom}px"><div class="cv" style="transform:scale(${E.zoom})"><svg class="edges" id="edges"></svg>${E.graph.nodes.map(noeud)}</div></div></div>
        <div class="drophint"></div>
        ${E.palOpen ? palette() : ''}
        ${sidePanel()}
      </div>`);
    if (keep) { $('#cvw').scrollLeft = keep[0]; $('#cvw').scrollTop = keep[1]; }
    if ($('#palList')) $('#palList').scrollTop = palScroll;
    drawEdges();
    bind();
  }

  function nodeState(n) { return E.exec?.state?.nodes?.[n.id]; }
  function noeud(n) {
    const d = defOf(n);
    const st = nodeState(n);
    const cls = st ? ({ done: 'ok', running: 'run', error: 'error', 'error-handled': 'error', waiting: 'waiting', skipped: 'skipped' }[st.status] || '') : '';
    const outs = outputsOf(n);
    const bad = d.missing || E.problems?.some(p => p.node === n.id);
    const src = n.instanceId ? (svc(n.instanceId)?.name || 'service supprimé') : KIND[d.cat] || '';
    const sub = n.type === 'trigger.service' || n.type === 'service.action' ? (d.description || n.ref) : d.sub;
    return html`<div class="nd ${E.sel === n.id ? 'sel' : ''} ${cls} ${bad ? 'bad' : ''}" data-node=${n.id} style="left:${n.x}px;top:${n.y}px">
      <div class="nd-carte"><div class="nh" data-drag=${n.id}><span class="itile ${tileCls(d)}">${I(d.icon || 'server')}</span><div class="nh-t"><small>${src}</small><b>${n.name}</b></div></div>
      <div class="nfoot"><span class="grow tronque">${st?.error || sub || ''}</span><span class="dotst"></span></div></div>
      ${d.trigger || d.passive && n.id === E.graph.edges[0]?.from ? '' : html`<button class="port in" data-in=${n.id} aria-label="Entrée de ${n.name}"></button>`}
      ${d.passive && n.id !== E.graph.edges[0]?.from ? '' : outs.length === 1 && outs[0] === 'main'
        ? html`<button class="port out ${E.arm?.node === n.id ? 'arm' : ''}" data-out=${n.id} data-port="main" aria-label="Sortie de ${n.name}"></button>`
        : html`<div class="ports-out">${outs.map(p => html`<button class="pout p-${p} ${E.arm?.node === n.id && E.arm.port === p ? 'arm' : ''}" data-out=${n.id} data-port=${p} aria-label="Sortie ${p}"><span>${PORT_LABEL[p] || p}</span></button>`)}</div>`}
    </div>`;
  }
  function portY(n, port) {
    const outs = outputsOf(n);
    if (outs.length === 1) return n.y + 32;
    return n.y + 22 + Math.max(0, outs.indexOf(port)) * 18;
  }
  function drawEdges() {
    const svg = $('#edges'); if (!svg) return;
    poser(svg, E.graph.edges.map((e, i) => {
      const A = byId(e.from), B = byId(e.to); if (!A || !B) return null;
      const x1 = A.x + NODE_W, y1 = portY(A, e.port || 'main'), x2 = B.x, y2 = B.y + 32, dx = Math.max(50, Math.abs(x2 - x1) / 2);
      const sa = nodeState(A), sb = nodeState(B);
      const active = sa && sa.status === 'done' && (sa.port === (e.port || 'main'));
      const cls = active && sb?.status === 'running' ? 'hot' : active && sb && sb.status !== 'skipped' ? 'done' : '';
      const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      return html`<path class="hit" data-edge=${i} d=${d}/><path class="wire ${cls} ${E.selEdge === i ? 'selected' : ''}" d=${d}/>`;
    }));
    $$('path.hit', svg).forEach(p => p.onclick = ev => { ev.stopPropagation(); E.selEdge = Number(p.dataset.edge); E.sel = null; render(); toast('Lien sélectionné : Suppr pour le retirer'); });
  }

  // Palette
  function paletteItems() {
    const items = [];
    for (const c of pal.core) items.push({ key: 'core:' + c.type, cat: c.cat, name: c.name, sub: c.sub, icon: c.icon });
    for (const s of pal.services) {
      for (const t of s.triggers) items.push({ key: `trg:${s.id}:${t.id}`, cat: 'trigger', group: s.name, name: t.name, sub: t.description, icon: t.icon || s.icon, off: s.status === 'offline' ? 'service injoignable' : '' });
      for (const a of s.actions) items.push({ key: `act:${s.id}:${a.id}`, cat: 'service', group: s.name, name: a.name, sub: a.risk === 'destructive' ? 'destructive · validation requise' : a.description, icon: a.icon || s.icon, off: s.status === 'offline' ? 'service injoignable' : '' });
    }
    return items;
  }
  function listePalette() {
    const q = E.q.trim().toLowerCase();
    const all = paletteItems().filter(it => !q || `${it.name} ${it.sub} ${it.group || ''}`.toLowerCase().includes(q));
    const blocs = pal.categories.map(([cat, label]) => {
      const list = all.filter(i => i.cat === cat);
      if (!list.length) return null;
      const shut = E.shut[cat] && !q;
      let inner = [];
      if (!shut) {
        const groups = {};
        for (const it of list) (groups[it.group || ''] ||= []).push(it);
        inner = Object.entries(groups).map(([g, its]) => [g ? html`<div class="papp">${g}</div>` : '', its.map(it => html`<div class="pit ${it.off ? 'off' : ''}" title=${it.off || null} draggable=${it.off ? null : 'true'} data-add=${it.off ? null : it.key} role=${it.off ? null : 'button'} tabindex=${it.off ? null : '0'}>
          <span class="itile sm ${cat === 'trigger' ? 'key' : cat === 'ai' ? 'ink' : ''}">${I(it.icon || 'server', 13)}</span><div><b>${it.name}</b><small>${it.off || it.sub || ''}</small></div></div>`)]);
      }
      return html`<button class="pcat ${shut ? 'shut' : ''}" data-cat=${cat}>${I('chev', 12)}${label}<span class="n">${list.length}</span></button>${inner}`;
    }).filter(Boolean);
    const missing = pal.catalog.length ? html`<div class="papp">Au catalogue, non installés</div>${pal.catalog.map(c => html`<div class="pit off" title="Installe-le depuis Extensions"><span class="itile sm">${I('plus', 13)}</span><div><b>${c.name}</b><small>${c.triggers} déclencheurs · ${c.actions} actions</small></div></div>`)}` : '';
    return [blocs.length ? blocs : html`<div class="list-empty">Aucun nœud ne correspond.</div>`, missing];
  }
  function palette() {
    return html`<aside class="pal2"><div class="ph2"><b>Ajouter un nœud</b><span class="note">glisser ou cliquer</span></div>
      <label class="search">${I('search', 14)}<input id="palQ" placeholder="Chercher un nœud…" value=${E.q} autocomplete="off"></label>
      <div class="lst" id="palList">${listePalette()}</div></aside>`;
  }
  function bindPalette() {
    const list = $('#palList'); if (!list) return;
    $$('[data-cat]', list).forEach(b => { b.onclick = () => { E.shut[b.dataset.cat] = !E.shut[b.dataset.cat]; poser(list, listePalette()); bindPalette(); }; });
    $$('[data-add]', list).forEach(el => {
      el.onclick = () => addNode(el.dataset.add);
      el.onkeydown = e => { if (e.key === 'Enter') addNode(el.dataset.add); };
      el.ondragstart = e => { e.dataTransfer.setData('text/plain', el.dataset.add); e.dataTransfer.effectAllowed = 'copy'; };
    });
  }

  function addNode(key, x, y) {
    const [kind, a, b] = key.split(':');
    let n;
    if (kind === 'core') { const d = coreDef(a); n = { id: uid(), type: a, name: uniqueName(d.name), params: {} }; }
    else if (kind === 'trg' || kind === 'act') {
      const s = svc(a); const d = (kind === 'trg' ? s.triggers : s.actions).find(x2 => x2.id === b);
      n = { id: uid(), type: kind === 'trg' ? 'trigger.service' : 'service.action', instanceId: a, ref: b, name: uniqueName(d.name), params: {} };
    }
    const cvw = $('#cvw');
    const auto = x == null;
    if (auto) {
      const left = E.palOpen ? 300 : 0;
      x = (cvw.scrollLeft + left + (cvw.clientWidth - left - (E.sel ? 340 : 0)) / 2) / E.zoom - NODE_W / 2 + (E.graph.nodes.length % 3) * 16;
      y = (cvw.scrollTop + cvw.clientHeight / 2) / E.zoom - 40 + (E.graph.nodes.length % 3) * 16;
    }
    n.x = Math.max(0, Math.round(x)); n.y = Math.max(0, Math.round(y));
    const prev = byId(E.sel);
    const d = defOf(n);
    E.graph.nodes.push(n);
    if (prev && !d.trigger) {
      const outs = outputsOf(prev);
      if (!E.graph.edges.some(e => e.from === prev.id && e.port === outs[0])) E.graph.edges.push({ from: prev.id, port: outs[0], to: n.id });
      if (auto) { n.x = prev.x + 280; n.y = prev.y + (E.graph.edges.filter(e => e.from === prev.id).length - 1) * 120; }
    }
    E.sel = n.id; E.selEdge = null; E.tab = 'params';
    markDirty(); render();
  }
  function uniqueName(base) {
    const names = new Set(E.graph.nodes.map(n => n.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  // Panneau latéral
  function sidePanel() {
    const n = byId(E.sel);
    if (n) return inspector(n);
    if (E.panel === 'runs') return runsPanel();
    const hooks = E.wf.webhooks?.length ? ' · webhook' : '';
    return html`<div class="wfinfo"><div>Origine<b>${E.wf.origin}</b></div><div>État<b>${E.wf.enabled ? 'actif' : 'coupé'}</b></div><div>Version<b>${E.wf.version}${hooks}</b></div></div>`;
  }
  function inspector(n) {
    const d = defOf(n);
    const st = nodeState(n);
    const svcDef = n.type === 'trigger.service' || n.type === 'service.action';
    const hook = E.wf.webhooks?.find(h => h.nodeId === n.id);
    const cron = E.wf.crons?.find(c => c.nodeId === n.id);
    const sub = E.wf.subscriptions?.find(s => s.nodeId === n.id);
    const settings = d.trigger || d.passive ? [] : pal.settings;
    let body;
    if (E.tab === 'data' && E.exec) {
      body = st ? html`
        <div class="fl"><label>État</label><div>${exTag(st.status === 'done' ? 'success' : st.status === 'error' || st.status === 'error-handled' ? 'error' : st.status)} ${st.port && st.port !== 'main' ? html`<span class="chip m">sortie ${st.port}</span>` : ''} ${st.attempts > 1 ? html`<span class="chip m">${st.attempts} essais</span>` : ''}</div></div>
        ${st.error ? html`<div class="errbox">${st.error}</div>` : ''}
        ${st.input !== undefined ? html`<span class="lab">Entrée</span><pre class="json">${JSON.stringify(st.input, null, 2)}</pre>` : ''}
        ${st.output !== undefined ? html`<span class="lab">Sortie</span><pre class="json">${JSON.stringify(st.output, null, 2)}</pre>` : ''}
        <button class="btn sm" id="replay">${I('refresh', 13)}Rejouer depuis ce nœud</button>`
        : html`<p class="hint">Ce nœud n’a pas été atteint dans cette exécution.</p>`;
    } else {
      body = html`
        <div class="fl"><label for="nodeName">Nom</label><input class="field" id="nodeName" value=${n.name}></div>
        ${d.missing ? html`<div class="errbox">Ce nœud référence un service, un déclencheur ou une action qui n’existe plus.</div>` : ''}
        ${svcDef && d.description ? html`<p class="hint">${d.description}</p>` : ''}
        ${d.risk === 'destructive' ? html`<div class="problems">Action destructive : une « Validation humaine » doit la précéder.</div>` : ''}
        ${hook ? html`<div class="hookbox"><b>Adresse du webhook</b><code>${hook.url}</code><span>${n.params?.auth === 'token' ? 'Jeton (en-tête X-Hub-Token)' : 'Secret HMAC'}</span>${E.secretNeuf?.nodeId === n.id ? html`<code>${E.secretNeuf.secret}</code><span class="help">Copie-le maintenant : il ne sera plus affiché.</span>` : html`<span class="help">Gardé chiffré par le Hub, jamais réaffiché.</span>`}<span class="help">${n.params?.auth === 'token' ? 'L’expéditeur envoie le jeton dans l’en-tête X-Hub-Token.' : 'Signature : en-tête X-Hub-Signature = sha256=HMAC(secret, corps).'}</span><div class="row"><button class="btn sm" id="hookSecret">${I('key', 13)}Nouveau secret</button></div></div>` : n.type === 'trigger.webhook' ? html`<p class="hint">Enregistre le workflow pour obtenir l’adresse du webhook.</p>` : ''}
        ${cron ? html`<p class="hint">${cron.error ? html`<span class="err">${cron.error}</span>` : `Prochain passage : ${new Date(cron.next).toLocaleString('fr-FR')}`}</p>` : ''}
        ${sub ? html`<p class="hint">${sub.kind === 'poll' ? `Dernière interrogation : ${when(sub.lastPoll)}` : 'Abonnement actif'}${sub.error ? html` · <span class="err">${sub.error}</span>` : ''}</p>` : ''}
        ${sub?.kind === 'service' ? html`<div class="row"><button class="btn sm" id="hookSecret" title="Le service se réabonne avec un secret de signature neuf">${I('key', 13)}Nouveau secret de signature</button></div>` : ''}
        ${n.type === 'core.link' && n.params?.ia?.instanceId ? html`<div class="ia-choix" id="iaChoix"><p class="hint">Chargement de l’IA du service…</p></div>` : ''}
        <div id="nodeForm">${d.params.length || settings.length ? formulaire([...d.params, ...settings], n.params, { instanceId: n.instanceId, lookups }, 'p') : html`<p class="hint">Aucun paramètre.</p>`}</div>
        ${svcDef && d.sample !== undefined ? html`<details><summary class="link small">Exemple de données produites</summary><pre class="json">${JSON.stringify(d.sample, null, 2)}</pre></details>` : ''}
        <p class="help">Expressions : {{ $json.champ }} (nœud précédent), {{ $trigger.champ }}, {{ $node["Nom"].json.champ }}, {{ $vars.NOM }}. Filtres : | upper | default("x") | json | length | date("DD/MM HH:mm").</p>
        <div class="row"><button class="btn sm" id="dupNode">Dupliquer</button><button class="btn flat sm danger" id="delNode">Retirer</button></div>`;
    }
    return html`<aside class="insp2">
      <header><span class="itile ${tileCls(d)}">${I(d.icon || 'server')}</span><div class="grow"><h2>${n.name}</h2><p>${KIND[d.cat] || ''}${n.instanceId ? ' · ' + (svc(n.instanceId)?.name || '?') : ''}</p></div><button class="ghost" id="deselect" aria-label="Fermer">${I('x', 14)}</button></header>
      ${E.exec ? html`<div class="insp-onglets"><div class="tabs"><button class="view ${E.tab === 'params' ? 'on' : ''}" data-tab="params">Paramètres</button><button class="view ${E.tab === 'data' ? 'on' : ''}" data-tab="data">Données</button></div></div>` : ''}
      <div class="bd">${body}</div></aside>`;
  }
  function runsPanel() {
    return html`<aside class="insp2">
      <header><span class="itile">${I('logs')}</span><div class="grow"><h2>Exécutions</h2><p>200 dernières conservées</p></div><button class="ghost" id="closeRuns" aria-label="Fermer">${I('x', 14)}</button></header>
      <div class="bd sans-marge">
        ${E.exec ? html`<div class="row exec-tete"><span class="grow small">Affichée : ${hhmm(E.exec.started)} ${E.exec.mode === 'test' ? '(test)' : ''}</span><button class="link" id="clearExec">Masquer</button></div>${E.exec.error ? html`<div class="errbox exec-erreur">${E.exec.error}</div>` : ''}` : ''}
        <div class="exlist">${E.execs.length ? E.execs.map(x => html`<div class="exrow ${E.exec?.id === x.id ? 'on' : ''}" data-ex=${x.id}>${exTag(x.status)}<span class="grow mono">${x.mode === 'test' ? 'test' : 'réel'} · v${x.version}</span><span class="mono">${when(x.started)}</span></div>`) : html`<div class="list-empty">Aucune exécution pour l’instant. Clique sur Tester.</div>`}</div>
      </div></aside>`;
  }

  // Actions
  async function reload() {
    const [w, p] = await Promise.all([GET(`/api/workflows/${wfId}`), GET('/api/palette')]);
    E.wf = w; Object.assign(pal, p);
    lookups.instances = p.services; lookups.ai = p.ai; lookups.workflows = p.workflows.filter(x => x.id !== wfId);
    if (!E.dirty) { E.graph = recaler(structuredClone(w.graph)); E.name = w.name; }
    E.problems = w.problems;
  }
  async function save() {
    try {
      const r = await PUT(`/api/workflows/${wfId}`, { name: E.name, graph: E.graph });
      E.dirty = false;
      await reload();
      E.problems = r.problems;
      toast('Workflow enregistré');
      render();
      return true;
    } catch (e) { fail(e); if (Array.isArray(e.details)) { E.problems = e.details; render(); } return false; }
  }
  async function loadExecs() { E.execs = await GET(`/api/workflows/${wfId}/executions`); }
  async function showExec(id) {
    E.exec = await GET(`/api/executions/${id}`);
    render();
  }
  async function run() {
    if (E.dirty && !(await save())) return;
    try {
      const r = await POST(`/api/workflows/${wfId}/run`, {});
      E.panel = 'runs';
      await loadExecs();
      await showExec(r.id);
      toast('Test lancé');
    } catch (e) { fail(e); }
  }
  function removeNode(id) {
    E.graph.nodes = E.graph.nodes.filter(n => n.id !== id);
    E.graph.edges = E.graph.edges.filter(e => e.from !== id && e.to !== id);
    if (E.sel === id) E.sel = null;
    markDirty(); render();
  }
  function setZoom(z) {
    const cvw = $('#cvw'), old = E.zoom;
    z = Math.max(0.3, Math.min(1.6, Math.round(z * 20) / 20));
    const cx = (cvw.scrollLeft + cvw.clientWidth / 2) / old, cy = (cvw.scrollTop + cvw.clientHeight / 2) / old;
    E.zoom = z; render();
    const c = $('#cvw'); c.scrollLeft = cx * z - c.clientWidth / 2; c.scrollTop = cy * z - c.clientHeight / 2;
  }
  function fit() {
    const cvw = $('#cvw'); if (!cvw || !E.graph.nodes.length) return;
    recaler(E.graph);
    const xs = E.graph.nodes.map(n => n.x), ys = E.graph.nodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + NODE_W + 60, minY = Math.min(...ys), maxY = Math.max(...ys) + 90;
    const left = E.palOpen ? 310 : 20, right = E.sel || E.panel ? 350 : 20;
    const aw = cvw.clientWidth - left - right - 30, ah = cvw.clientHeight - 60;
    E.zoom = Math.max(0.35, Math.min(1, aw / Math.max(1, maxX - minX), ah / Math.max(1, maxY - minY))) || 1;
    E.zoom = Math.floor(E.zoom * 20) / 20;
    render();
    const c = $('#cvw');
    c.scrollLeft = Math.max(0, minX * E.zoom - left - Math.max(0, (aw - (maxX - minX) * E.zoom) / 2));
    c.scrollTop = Math.max(0, minY * E.zoom - 30 - Math.max(0, (ah - (maxY - minY) * E.zoom) / 2));
  }

  function moreMenu() {
    modal({ title: 'Workflow', sub: E.name, body: html`
      <div class="row"><button class="btn" data-m="versions">${I('clock', 14)}Versions</button><button class="btn" data-m="export">${I('export', 14)}Exporter en JSON</button><button class="btn danger" data-m="delete">Supprimer le workflow</button></div>
      <div id="mBody"></div>`, onOpen: (m, close) => {
      $$('[data-m]', m).forEach(b => b.onclick = async () => {
        const what = b.dataset.m;
        if (what === 'versions') {
          const list = await GET(`/api/workflows/${wfId}/versions`);
          poser($('#mBody', m), html`<div class="card carte-plate">${list.map(v => html`<div class="setrow"><div><b>Version ${v.version}</b><small>${v.author} · ${when(v.created)}</small></div><div class="r">${v.version === E.wf.version ? html`<span class="chip a">actuelle</span>` : html`<button class="btn sm" data-restore=${v.version}>Restaurer</button>`}</div></div>`)}</div>`);
          $$('[data-restore]', m).forEach(r => r.onclick = async () => {
            try { await POST(`/api/workflows/${wfId}/restore`, { version: Number(r.dataset.restore) }); E.dirty = false; await reload(); close(); render(); toast('Version restaurée'); } catch (e) { fail(e); }
          });
        }
        if (what === 'export') {
          const data = await GET(`/api/workflows/${wfId}/export`);
          poser($('#mBody', m), html`<p class="help">Copie ce JSON pour l’importer ailleurs (Workflows → Importer). Les secrets n’y figurent pas.</p><textarea class="field haut-260" readonly>${JSON.stringify(data, null, 2)}</textarea>`);
        }
        if (what === 'delete') {
          close();
          if (await confirmBox('Supprimer ce workflow ?', `« ${E.name} » et son historique seront supprimés.`, 'Supprimer')) {
            try { await DEL(`/api/workflows/${wfId}`); toast('Workflow supprimé'); app.go('wf'); } catch (e) { fail(e); }
          }
        }
      });
    } });
  }

  // Événements
  function bind() {
    $('#eBack').onclick = async () => {
      if (E.dirty && !(await confirmBox('Quitter sans enregistrer ?', 'Tes modifications seront perdues.', 'Quitter'))) return;
      app.go('wf');
    };
    $('#wfName').oninput = e => { E.name = e.target.value; markDirty(); };
    if ($('#fixNoms')) $('#fixNoms').onclick = async () => {
      // Le serveur renomme et enregistre en une fois : rien à valider à la
      // main. On repart de ce qu'il renvoie, sinon un brouillon local
      // écraserait le renommage au prochain enregistrement.
      try {
        const r = await POST(`/api/workflows/${wfId}/reparer/noms`, {});
        E.dirty = false;
        await reload();
        E.graph = recaler(structuredClone(E.wf.graph)); E.name = E.wf.name;
        render();
        toast(r.renommes.length ? r.renommes.map(x => `« ${x.de} » → « ${x.vers} »`).join(', ') : 'Rien à renommer');
      } catch (e) { fail(e); }
    };
    $('#zIn').onclick = () => setZoom(E.zoom + 0.1);
    $('#zOut').onclick = () => setZoom(E.zoom - 0.1);
    $('#zFit').onclick = fit;
    $('#palTog').onclick = () => { E.palOpen = !E.palOpen; render(); };
    $('#runsTog').onclick = async () => { E.panel = E.panel === 'runs' ? null : 'runs'; E.sel = null; if (E.panel) await loadExecs(); render(); };
    $('#more').onclick = moreMenu;
    $('#save').onclick = save;
    $('#run').onclick = run;
    $('#enable').onclick = async () => {
      if (E.dirty && !(await save())) return;
      try { await POST(`/api/workflows/${wfId}/enable`, { enabled: !E.wf.enabled }); await reload(); render(); toast(E.wf.enabled ? 'Workflow activé' : 'Workflow coupé'); }
      catch (e) { fail(e); if (Array.isArray(e.details)) { E.problems = e.details; render(); } }
    };
    const pq = $('#palQ');
    if (pq) pq.oninput = () => { E.q = pq.value; poser($('#palList'), listePalette()); bindPalette(); };
    bindPalette();

    // inspecteur
    $('#deselect')?.addEventListener('click', () => { E.sel = null; render(); });
    $('#closeRuns')?.addEventListener('click', () => { E.panel = null; render(); });
    $('#clearExec')?.addEventListener('click', () => { E.exec = null; render(); });
    $$('[data-ex]').forEach(r => r.onclick = () => showExec(r.dataset.ex));
    $$('[data-tab]').forEach(b => b.onclick = () => { E.tab = b.dataset.tab; render(); });
    $('#replay')?.addEventListener('click', async () => {
      try { const r = await POST(`/api/executions/${E.exec.id}/replay`, { nodeId: E.sel }); await loadExecs(); await showExec(r.id); toast('Rejeu lancé'); } catch (e) { fail(e); }
    });
    const n = byId(E.sel);
    if (n) {
      $('#nodeName')?.addEventListener('input', e => {
        n.name = e.target.value; markDirty();
        const el = $(`[data-node="${CSS.escape(n.id)}"] .nh b`); if (el) el.textContent = n.name;
      });
      const form = $('#nodeForm');
      if (form) {
        const d = defOf(n);
        if (n.instanceId) bindDynamic(form, n.instanceId, n.type === 'trigger.service' ? 'trigger' : 'action', n.ref);
        let t;
        form.oninput = form.onchange = ev => {
          clearTimeout(t);
          t = setTimeout(() => {
            try {
              const vals = readForm(form, { keepEmpty: true });
              for (const [k, v] of Object.entries(vals)) { if (v === '') delete n.params[k]; else n.params[k] = v; }
              markDirty();
              const structural = ['cases', 'categories', '_onError', 'instance'].includes(ev.target.dataset.key);
              if (structural) render(); else drawEdges();
            } catch (e) { /* JSON en cours de saisie */ }
          }, ev.type === 'change' ? 0 : 250);
        };
        void d;
      }
      // Le lien « service → IA » : l'IA du service se choisit ici même, par ses
      // propres champs (mode, modèle local, fournisseur en nuage), et le Hub
      // relance le service installé ici pour qu'il la prenne.
      const choixIA = $('#iaChoix');
      if (choixIA && n.params?.ia?.instanceId) {
        const iid = n.params.ia.instanceId;
        GET(`/api/instances/${encodeURIComponent(iid)}/ia`).then(r => {
          poser(choixIA, html`<div class="ia-tete"><span class="lab">IA de ${r.instance.name}</span><button class="link small" type="button" id="iaVersPage">Brancher une IA au Hub</button></div>
            <div id="iaForm">${formulaire(r.champs, r.config, { instanceId: iid }, 'ia')}</div>
            <div class="row"><button class="btn sm solid" id="iaAppliquer">Appliquer${r.instance.mode === 'compose' ? ' et relancer' : ''}</button><span class="help" id="iaMsg"></span></div>`);
          bindDynamic($('#iaForm', choixIA), iid, 'config', null);
          $('#iaVersPage', choixIA).onclick = () => app.go('ia');
          $('#iaAppliquer', choixIA).onclick = async () => {
            const b = $('#iaAppliquer', choixIA); b.disabled = true;
            try {
              const config = readForm($('#iaForm', choixIA), { keepEmpty: true });
              const out = await PUT(`/api/instances/${encodeURIComponent(iid)}/ia`, { config });
              toast(out.relance ? `IA de ${r.instance.name} appliquée, service relancé` : `IA de ${r.instance.name} appliquée`);
              await reload();
            } catch (e) { fail(e); b.disabled = false; }
          };
        }).catch(e => poser(choixIA, html`<p class="hint err">${e.message}</p>`));
      }
      $('#dupNode')?.addEventListener('click', () => {
        const c = structuredClone(n); c.id = uid(); c.name = uniqueName(n.name); c.x += 40; c.y += 60;
        E.graph.nodes.push(c); E.sel = c.id; markDirty(); render();
      });
      $('#delNode')?.addEventListener('click', () => removeNode(n.id));
      $('#hookSecret')?.addEventListener('click', async () => {
        if (!(await confirmBox('Remplacer le secret ?', 'L’ancien cesse aussitôt de valider les envois : l’expéditeur devra recevoir le nouveau.', 'Remplacer'))) return;
        try { const r = await POST(`/api/workflows/${wfId}/webhooks/${encodeURIComponent(n.id)}/secret`, {}); if (r.secret) E.secretNeuf = { nodeId: n.id, secret: r.secret }; render(); toast(r.secret ? 'Secret remplacé' : 'Secret remplacé, service réabonné'); }
        catch (e) { fail(e); }
      });
    }

    // canevas
    const cvw = $('#cvw'), eb = $('#edbody');
    cvw.ondragover = e => { e.preventDefault(); eb.classList.add('over'); };
    cvw.ondragleave = () => eb.classList.remove('over');
    cvw.ondrop = e => {
      e.preventDefault(); eb.classList.remove('over');
      const k = e.dataTransfer.getData('text/plain'); if (!k) return;
      const r = cvw.getBoundingClientRect();
      const prevSel = E.sel; E.sel = null;
      addNode(k, (e.clientX - r.left + cvw.scrollLeft) / E.zoom - NODE_W / 2, (e.clientY - r.top + cvw.scrollTop) / E.zoom - 30);
      void prevSel;
    };
    // déplacement du canevas par glisser sur le fond
    cvw.onpointerdown = e => {
      if (e.target.closest('.nd') || e.target.closest('path.hit')) return;
      const sx = e.clientX, sy = e.clientY, ox = cvw.scrollLeft, oy = cvw.scrollTop;
      let moved = false;
      const mv = ev => { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true; cvw.scrollLeft = ox - (ev.clientX - sx); cvw.scrollTop = oy - (ev.clientY - sy); };
      const up = () => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
        if (!moved && (E.sel || E.arm || E.selEdge !== null)) { E.sel = null; E.arm = null; E.selEdge = null; render(); }
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    };
    cvw.onwheel = e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(E.zoom + (e.deltaY < 0 ? 0.1 : -0.1)); } };

    $$('[data-node]').forEach(el => el.onclick = e => {
      e.stopPropagation();
      if (e.target.closest('.port,.pout') || el.dataset.moved) { delete el.dataset.moved; return; }
      E.sel = el.dataset.node; E.selEdge = null; E.panel = E.panel === 'runs' && E.exec ? 'runs' : E.panel;
      if (E.exec) E.tab = E.tab || 'data';
      render();
    });
    $$('[data-out]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const cur = E.arm;
      E.arm = cur && cur.node === b.dataset.out && cur.port === b.dataset.port ? null : { node: b.dataset.out, port: b.dataset.port };
      render();
      if (E.arm) toast('Clique maintenant sur l’entrée (point de gauche) d’un autre nœud');
    });
    $$('[data-in]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const to = b.dataset.in;
      if (E.arm && E.arm.node !== to) {
        if (!E.graph.edges.some(x => x.from === E.arm.node && x.to === to && x.port === E.arm.port)) { E.graph.edges.push({ from: E.arm.node, port: E.arm.port, to }); markDirty(); }
      }
      E.arm = null; render();
    });
    $$('[data-drag]').forEach(h => h.onpointerdown = e => {
      e.stopPropagation();
      const n2 = byId(h.dataset.drag), el = h.closest('.nd');
      const sx = e.clientX, sy = e.clientY, ox = n2.x, oy = n2.y, z = E.zoom;
      h.setPointerCapture(e.pointerId);
      h.onpointermove = ev => {
        const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
        if (Math.abs(dx) + Math.abs(dy) > 3) el.dataset.moved = '1';
        n2.x = Math.max(0, Math.min(3180, Math.round(ox + dx))); n2.y = Math.max(0, Math.min(1930, Math.round(oy + dy)));
        el.style.left = n2.x + 'px'; el.style.top = n2.y + 'px'; drawEdges();
      };
      h.onpointerup = () => { h.onpointermove = null; h.onpointerup = null; if (el.dataset.moved) markDirty(); };
    });
  }

  function onKey(e) {
    if (!document.body.contains(stage) || !$('#edbody')) { document.removeEventListener('keydown', onKey); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); return; }
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.querySelector('.voile')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (E.selEdge !== null) { E.graph.edges.splice(E.selEdge, 1); E.selEdge = null; markDirty(); render(); }
      else if (E.sel) removeNode(E.sel);
    }
    if (e.key === 'Escape') { E.sel = null; E.arm = null; E.selEdge = null; render(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'd' && E.sel) { e.preventDefault(); $('#dupNode')?.click(); }
  }
  document.addEventListener('keydown', onKey);

  // temps réel
  let pending = null;
  const onExec = async ev => {
    if (!$('#edbody')) return;
    if (ev.workflowId && ev.workflowId !== wfId) return;
    if (ev.executionId && E.exec?.id !== ev.executionId) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      if (E.exec) E.exec = await GET(`/api/executions/${E.exec.id}`).catch(() => E.exec);
      if (E.panel === 'runs') await loadExecs().catch(() => {});
      render();
    }, 150);
  };
  app.on('execution', onExec);
  app.on('execution.node', onExec);
  app.on('workflow', async ev => { if (ev.id === wfId && !E.dirty && $('#edbody')) { await reload(); render(); } });

  render();
  requestAnimationFrame(fit);
  window.onbeforeunload = () => (E.dirty ? true : undefined);
  return { isDirty: () => E.dirty };
}
