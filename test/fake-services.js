// Faux services HTTP pour les tests : un docker-control, un SYNAPSE et un Ollama.
import http from 'node:http';
import crypto from 'node:crypto';

export function startFake() {
  const state = {
    comptesSocle: [
      { id: "c_aaaaaaaaaaaaaaaa", identifiant: "admin", role: "admin", a2f: true, cree: 1, derniere: Date.now() - 3600e3, courriel: "administrateur.du.parc@exemple.org", cle: "toujours", actif: true, facteurs: { motdepasse: true, totp: true, cles: 0, secours: 10 }, manquants: ["cle"] },
      { id: "c_bbbbbbbbbbbbbbbb", identifiant: "bruno", role: "membre", a2f: false, cree: 2, derniere: null, courriel: "", cle: "facultative", actif: true, facteurs: { motdepasse: false, totp: false, cles: 0, secours: 0 }, manquants: ["motdepasse", "second"] },
      { id: "c_cccccccccccccccc", identifiant: "camille.lecture", role: "lecture", a2f: true, cree: 3, derniere: Date.now() - 86400e3, courriel: "camille@exemple.org", cle: "exigee", actif: false, facteurs: { motdepasse: true, totp: false, cles: 2, secours: 0 }, manquants: [] },
    ],
    comptesLibres: [
      { id: 'u1', username: 'testsyn', role: 'admin', totp: true, last_login: '2026-09-28T10:01:00Z', origin: true },
      { id: 'u2', username: 'lecture-memoire', role: 'reader', totp: false, last_login: null, origin: false },
    ],
    containers: [{ name: 'helpdesk-web', state: 'running', image: 'helpdesk:2.4.1', node: 'node-1' }, { name: 'synapse', state: 'running', image: 'synapse:2', node: 'node-1' }],
    hooks: new Map(), facts: [], deployments: [], restarts: [], chats: [], planResponse: null,
    // Relay (vitrine) : des routes de chaque sorte, dont un nom long.
    relay: {
      domaines: ['home.arpa'], ip: '192.0.2.10', zonesCloudflare: [], cloudflare: true, caddy: { at: Date.now(), ok: true, erreur: null },
      routes: [
        { id: 'r_carte00000', nom: 'MapMyLAN', hote: 'mapmylan.home.arpa', cible: 'hub-mapmylan:8090', mode: 'local', cf: false, actif: true, proprietaire: 'hub:mapmylan', sante: { ok: true, ms: 3 } },
        { id: 'r_hyperv0000', nom: 'Hyperviseur', hote: 'hyperviseur-de-la-salle-serveur.home.arpa', cible: 'https://192.0.2.30:8006', mode: 'local', cf: false, actif: true, proprietaire: null, sante: { ok: false, ms: 2500 } },
        { id: 'r_public0000', nom: '', hote: 'statut.exemple.org', cible: 'hub-oracle:8090', mode: 'clair', cf: true, actif: false, proprietaire: 'service:statut', sante: null },
      ],
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString()) : null; } catch { body = null; }   // l'audio n'est pas du JSON
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const p = url.pathname;
    // docker-control
    if (p === '/api/health') return send(200, { ok: true });
    // Comptes d'un service du socle, administrés par le Hub (vitrine).
    // Comptes d'un service hors socle (forme libre décrite par son manifeste), sous /syn pour SYNAPSE.
    const pu = p.replace(/^\/syn(?=\/api\/users)/, '');
    if (pu === '/api/users' && req.method === 'GET') return send(200, state.comptesLibres);
    if (pu === '/api/users' && req.method === 'POST') { const b = body || {}; const u = { id: 'u' + (state.comptesLibres.length + 1), username: b.username, role: b.role || 'user', totp: false, last_login: null }; state.comptesLibres.push(u); return send(201, u); }
    if (/^\/api\/users\/[\w-]+(\/password)?$/.test(pu)) {
      const id = pu.split('/')[3], i = state.comptesLibres.findIndex(u => u.id === id);
      if (i < 0) return send(404, { detail: 'inconnu' });
      if (req.method === 'DELETE') { state.comptesLibres.splice(i, 1); return send(200, { ok: true }); }
      if (req.method === 'PATCH') { if (body?.role) state.comptesLibres[i].role = body.role; return send(200, state.comptesLibres[i]); }
      return send(200, { ok: true });
    }
    if (p === '/api/compte/hub/comptes' && req.method === 'GET') return send(200, state.comptesSocle);
    if (p.startsWith('/api/compte/hub/comptes')) return send(200, req.method === 'POST' && p.endsWith('/reinit') ? { lien: 'http://localhost/#reinit=x', message: 'Lien de réinitialisation à transmettre.' } : { ok: true });
    // Relay
    if (p === '/api/etat') return send(200, state.relay);
    if (p === '/api/hub/publication' && req.method === 'PUT') return send(200, { url: `https://${body.sousDomaine}.${state.relay.domaines[0]}`, route: {} });
    if (p === '/api/hub/cloudflare' && req.method === 'PUT') { state.relay.zonesCloudflare = ['example.org', 'un-autre-domaine-assez-long.example.net']; return send(200, { zones: state.relay.zonesCloudflare, enregistrements: { faits: [], erreurs: [] } }); }
    if (p === '/api/hub/cloudflare' && req.method === 'DELETE') { state.relay.zonesCloudflare = []; return send(200, { ok: true }); }
    if (p === '/api/reglages/general' && req.method === 'PUT') { state.relay.domaines = body.domaines; return send(200, body); }
    if (p === '/api/autorite') { res.writeHead(200, { 'Content-Type': 'application/x-pem-file' }); return res.end('-----BEGIN CERTIFICATE-----\nVITRINE\n-----END CERTIFICATE-----\n'); }
    if (p === '/api/containers' && req.method === 'GET') return send(200, { items: state.containers });
    let m;
    if ((m = /^\/api\/containers\/([^/]+)\/logs$/.exec(p))) return send(200, { lines: ['Killed process 4112 (node)', `tail=${url.searchParams.get('tail')}`] });
    if ((m = /^\/api\/containers\/([^/]+)\/restart$/.exec(p))) { state.restarts.push(m[1]); return send(200, { ok: true, state: 'running' }); }
    if ((m = /^\/api\/containers\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { state.containers = state.containers.filter(c => c.name !== m[1]); return send(200, { ok: true }); }
    if (p === '/api/webhooks' && req.method === 'POST') { const hid = 'wh' + (state.hooks.size + 1); state.hooks.set(hid, body); return send(201, { id: hid }); }
    if ((m = /^\/api\/webhooks\/([^/]+)$/.exec(p)) && req.method === 'DELETE') { state.hooks.delete(m[1]); return send(200, { ok: true }); }
    if (p === '/api/deployments') return send(200, { items: state.deployments, lastTimestamp: Date.now() });
    if (p === '/api/metrics/containers') return send(200, state.containers.map((c, i) => ({ name: c.name, memoryPercent: 40 + i * 50, restartCount: 2 })));
    if (p === '/api/nodes') return send(200, { connected: 1 });
    // SYNAPSE
    if (p === '/syn/health') return send(200, { ok: true });
    if (p === '/syn/v1/ingest') { state.facts.push({ ...body, auth: req.headers.authorization }); return send(201, { id: 'fact_' + state.facts.length }); }
    if (p === '/syn/v1/search') return send(200, { hits: state.facts.filter(f => JSON.stringify(f).includes(url.searchParams.get('q') || '')).map(f => ({ text: f.text })) });
    if (p === '/syn/v1/stats') return send(200, { facts: state.facts.length });
    // Ollama
    if (p.startsWith('/tg/bot')) {
      // Un faux Telegram : les envois sont gardés, et une réponse « de l'utilisateur » peut suivre.
      const tg = state.tg ||= { updates: [], sent: [], id: 100 };
      if (p.endsWith('/sendMessage')) {
        // `coupures` : autant de connexions coupées net avant de répondre (« fetch failed »).
        if (tg.coupures > 0) { tg.coupures--; return req.socket.destroy(); }
        body.message_id = ++tg.mid || (tg.mid = 1000);
        tg.sent.push(body);
        // Un « 💭 / ⚙️ » d'attente n'appelle pas de réponse de l'utilisateur.
        if (/^(💭|⚙️)/.test(body.text)) return send(200, { ok: true, result: { message_id: body.message_id } });
        // `repondre` : une réponse, ou une liste — une par message envoyé.
        const txt = Array.isArray(tg.repondre) ? tg.repondre.shift() : tg.repondre;
        if (!Array.isArray(tg.repondre) || !tg.repondre.length) tg.repondre = null;
        if (txt) setTimeout(() => tg.updates.push({ update_id: ++tg.id, message: { chat: { id: Number(body.chat_id) }, text: txt } }), 300);
        return send(200, { ok: true, result: { message_id: body.message_id } });
      }
      if (p.endsWith('/sendAudio')) {
        // Multipart : on garde la taille et le texte brut (légende, chat_id, type).
        (tg.audio ||= []).push({ taille: raw.length, brut: raw.toString('latin1') });
        return send(200, { ok: true, result: { message_id: ++tg.mid || (tg.mid = 1000) } });
      }
      if (p.endsWith('/deleteMessage')) {
        (tg.supprimes ||= []).push(body.message_id);
        return send(200, { ok: true, result: true });
      }
      if (p.endsWith('/getUpdates')) {
        // `coupuresEcoute` : autant d'attentes coupées net (réseau qui lâche pendant l'écoute).
        if (tg.coupuresEcoute > 0 && url.searchParams.get('offset') !== '-1') { tg.coupuresEcoute--; return req.socket.destroy(); }
        const off = Number(url.searchParams.get('offset') || 0);
        const liste = off < 0 ? tg.updates.slice(off) : tg.updates.filter(u => u.update_id >= off);
        if (liste.length || off < 0) return send(200, { ok: true, result: liste });
        const t0 = Date.now();
        const attendre = () => { const l = tg.updates.filter(u => u.update_id >= off); if (l.length || Date.now() - t0 > 1500) return send(200, { ok: true, result: l }); setTimeout(attendre, 100); };
        return attendre();
      }
    }
    // ElevenLabs : la voix, facturée au caractère.
    if (p.startsWith('/el/v1/text-to-speech/') && req.method === 'POST') {
      if (req.headers['xi-api-key'] !== 'sk_eleven_test_0123456789abcdef') return send(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      (state.eleven ||= []).push({ voix: p.split('/').pop(), format: url.searchParams.get('output_format'), ...body });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end('ID3:' + body.text);
    }
    if (p === '/el/v1/voices') {
      if (req.headers['xi-api-key'] !== 'sk_eleven_test_0123456789abcdef') return send(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
      return send(200, { voices: [{ voice_id: 'voixDeTest1234', name: 'Léa', category: 'premade', preview_url: 'https://storage.googleapis.com/extrait/lea.mp3', labels: { gender: 'female', language: 'fr' } }, { voice_id: '../../etc', name: 'Piège' }] });
    }
    // VOX : la clé ElevenLabs poussée par le Hub.
    if (p === '/v1/hub/voix' && req.method === 'POST') { (state.voxCle ||= []).push({ auth: req.headers.authorization, ...body }); return send(200, { ok: true }); }
    // VOX : l'oreille et la voix.
    if (p === '/health') return send(200, { ok: true, services: { stt: 'ok', tts: 'ok' } });
    if (p === '/v1/transcrire' && req.method === 'POST') {
      (state.vox ||= []).push({ auth: req.headers.authorization, taille: raw.length });
      return send(200, { text: raw.toString().includes('STOP') ? 'Stop.' : ' état des services ', ms: 5 });
    }
    if (p === '/v1/dire' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end('RIFF:' + body.text); }
    if (p === '/discord' && req.method === 'POST') { (state.discord ||= []).push(body); return send(204, {}); }
    if (p === '/compat/models') return req.headers.authorization === 'Bearer sk-kimi-test' ? send(200, { data: [{ id: 'kimi-k2' }, { id: 'moonshot-v1-8k' }] }) : send(401, { error: { message: 'Invalid Authentication' } });
    if (p === '/api/version') return send(200, { version: '0.9.0' });
    if (p === '/api/tags') return send(200, { models: [{ name: 'qwen3:8b', size: 1 }, { name: 'nomic-embed-text:latest', size: 1 }] });
    if (p === '/api/ps') return send(200, { models: [{ name: 'qwen3:8b', digest: 'abc', size_vram: 5e9 }] });
    if (p === '/api/embed') return send(200, { embeddings: [[0.1, 0.2, 0.3]] });
    if (p === '/api/chat') {
      state.chats.push(body);
      const sys = body.messages.find(x => x.role === 'system')?.content || '';
      let content;
      if (sys.includes('assistant de configuration')) {
        // Une chaîne dans la file : renvoyée telle quelle (un modèle qui ne rend pas de JSON).
        const x = (state.planQueue && state.planQueue.length ? state.planQueue.shift() : null) || state.planResponse || { reply: 'Rien à faire.', steps: [] };
        content = typeof x === 'string' ? x : JSON.stringify(x);
      }
      else if (sys.includes('tu discutes avec lui sur Telegram')) {
        const msg = String(body.messages.at(-1).content).split('\n').at(-1);
        content = JSON.stringify((state.convQueue && state.convQueue.length ? state.convQueue.shift() : null) || { reply: `Reçu : ${msg}`, hub: '' });
      }
      else if (sys.includes('Classe')) content = JSON.stringify({ category: 'incident', reason: 'OOM' });
      else if (body.format === 'json') content = JSON.stringify({ ok: true });
      else content = 'helpdesk-web manque de mémoire (code 137). Passer la limite à 512 Mo.';
      return send(200, { message: { role: 'assistant', content }, prompt_eval_count: 10, eval_count: 5 });
    }
    send(404, { error: 'not found ' + p });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base, state, close: () => server.close(),
      // envoie un événement signé à tous les webhooks abonnés
      async emit(event) {
        const out = [];
        for (const h of state.hooks.values()) {
          const raw = JSON.stringify(event);
          const sig = 'sha256=' + crypto.createHmac('sha256', h.secret).update(raw).digest('hex');
          const r = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DC-Signature': sig }, body: raw });
          out.push({ status: r.status, body: await r.json() });
        }
        return out;
      },
    });
  }));
}
