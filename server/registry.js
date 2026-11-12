// Catalogue d'extensions : registres GitHub ou dossier local, manifestes vérifiés et validés.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from './manifest/validator.js';
import { config } from './config.js';
import { HttpError, log, sha256 } from './util/common.js';
import { sortir } from './sortie.js';
import { compareVersions } from './services.js';

const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest/schema.json'), 'utf8'));
export const validateManifest = createValidator(schema);

/**
 * Un registre tel qu'on le colle : le lien d'un compte GitHub
 * (https://github.com/Nesaris), d'un dépôt (…/compte/dépôt, …/tree/branche),
 * ou un nom de compte seul, devient l'écriture du Hub (github-user:compte,
 * github:compte/dépôt@branche). Les autres écritures passent telles quelles.
 */
export function sourceDepuisLien(brut) {
  const s = String(brut || '').trim().replace(/^git\+/, '');
  const compte = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]{1,39})\/?$/i.exec(s) || /^@?([A-Za-z0-9][\w-]{0,38})$/.exec(s);
  if (compte && compte[1] !== 'local') return `github-user:${compte[1]}`;
  const depot = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]{1,39})\/([\w.-]{1,100}?)(?:\.git)?(?:\/tree\/([\w./-]{1,100}?))?\/?$/i.exec(s);
  if (depot) return `github:${depot[1]}/${depot[2]}${depot[3] ? `@${depot[3]}` : ''}`;
  return s;
}
/** Le lien GitHub d'un registre, pour l'afficher ; null s'il n'est pas sur GitHub. */
export function lienDe(source) {
  const u = /^github-user:([\w.-]+)$/.exec(source);
  if (u) return `https://github.com/${u[1]}`;
  const d = /^github:([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/.exec(source);
  return d ? `https://github.com/${d[1]}${d[2] ? `/tree/${d[2]}` : ''}` : null;
}

export function parseSource(s) {
  if (s === 'local') return { type: 'local', dir: config.registryLocalDir, label: 'local' };
  const u = /^github-user:([\w.-]+)$/.exec(s);
  if (u) return { type: 'github-user', owner: u[1], label: s };
  const m = /^github:([\w.-]+\/[\w.-]+)(?:@([\w./-]+))?$/.exec(s);
  if (m) return { type: 'github', repo: m[1], ref: m[2] || 'main', label: s };
  if (/^https:\/\//.test(s)) return { type: 'url', base: s.replace(/\/index\.json$/, '').replace(/\/$/, ''), label: s };
  if (s.startsWith('dir:')) return { type: 'local', dir: path.resolve(s.slice(4)), label: s };
  throw new HttpError(400, `Registre invalide : ${s} (attendu github-user:compte, github:propriétaire/dépôt@ref, https://…/index.json ou dir:/chemin)`);
}

const rawUrl = (repo, ref, p) => `https://raw.githubusercontent.com/${repo}/${ref}/${p.replace(/^\//, '')}`;

// Le commit au bout d'une branche ou d'une étiquette, lu par le protocole git
// en HTTP (github.com/…/info/refs) : ni quota d'API, ni cache. Le CDN de
// raw.githubusercontent garde une branche jusqu'à cinq minutes et ignore les
// paramètres d'adresse ; une adresse par commit, elle, ne change jamais.
const COMMIT = /^[0-9a-f]{40}$/;
export function commitDe(annonce, ref) {
  if (COMMIT.test(ref)) return ref;
  // Lignes « paquet » : 4 chiffres de longueur (8 après la ligne de service),
  // le commit, le nom, puis sur la première les capacités après un octet nul.
  const refs = new Map();
  for (const ligne of String(annonce).split('\n')) {
    const m = /^([0-9a-f]{40,48}) ([^\0\s]+)/.exec(ligne);
    if (m) refs.set(m[2], m[1].slice(-40));
  }
  return refs.get(`refs/heads/${ref}`) || refs.get(`refs/tags/${ref}^{}`) || refs.get(`refs/tags/${ref}`) || null;
}

const AUTO_MS = config.catalogueAutoMs;

export class Registry {
  constructor({ db, audit, bus }) { this.db = db; this.audit = audit; this.bus = bus; this.errors = []; }

  // L'ancien registre par défaut, écrit dans les .env et les réglages d'avant
  // 0.16 : ses dépôts ont rejoint le compte Nesaris, lu à sa place.
  sources() { return [...new Set(this.db.setting('registries', [config.registryDefault, 'local']).map(s => s === 'github-user:CodexX64' ? 'github-user:Nesaris' : s))]; }
  setSources(liste, actor) {
    const list = [...new Set(liste.map(sourceDepuisLien).filter(Boolean))];
    list.forEach(parseSource);
    this.db.setSetting('registries', list);
    this.audit.write(actor, 'registres.modifiés', null, { list });
  }

  async readFile(origin, rel) {
    const p = path.posix.normalize(path.posix.join(origin.dir || '', rel));
    if (p.startsWith('..')) throw new HttpError(400, 'Chemin hors du dépôt');
    if (origin.type === 'local') {
      const racine = path.resolve(origin.root), full = path.resolve(racine, p);
      // Le séparateur compte : « /reg-voisin » commence aussi par « /reg ».
      if (full !== racine && !full.startsWith(racine + path.sep)) throw new HttpError(400, 'Chemin hors du dossier');
      return fs.promises.readFile(full);
    }
    // En plus des en-têtes, une adresse neuve à chaque lecture : le CDN range
    // ses copies par adresse complète, une adresse jamais vue ne peut être servie de son cache.
    const url = origin.type === 'github' ? (origin.sha ? rawUrl(origin.repo, origin.sha, p) : `${rawUrl(origin.repo, origin.ref, p)}?t=${Date.now()}`) : `${origin.base}/${p}`;
    // Actualiser le catalogue est un geste explicite : on veut l'état du
    // dépôt maintenant, pas ce qu'un cache a retenu. Le CDN de
    // raw.githubusercontent garde un fichier plusieurs minutes, ce qui fait
    // qu'un manifeste tout juste poussé n'arrive pas — et rien ne le dit.
    const res = await sortir(url, { signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
    if (!res.ok) throw new HttpError(502, `Téléchargement impossible (${res.status}) : ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * L'actualisation automatique, à chaque chargement de page : une seule en
   * vol à la fois, et pas plus d'une par AUTO_MS — le listage des dépôts
   * GitHub est limité à 60 appels par heure sans jeton.
   */
  async refreshAuto() {
    const depuis = Date.now() - (this.db.setting('registry_refreshed', 0) || 0);
    if (this.enCours) return this.enCours;
    if (depuis < AUTO_MS) return { count: null, errors: this.errors, recent: true };
    return this.refresh('hub');
  }

  async refresh(actor = 'hub') {
    if (this.enCours) return this.enCours;
    this.enCours = this.refreshMaintenant(actor).finally(() => { this.enCours = null; });
    return this.enCours;
  }

  /** Le commit d'une branche GitHub, ou null (le dépôt est alors lu par sa branche, comme avant). */
  async commit(repo, ref) {
    if (COMMIT.test(ref)) return ref;
    const cle = `${repo}@${ref}`;
    if (this.commits?.has(cle)) return this.commits.get(cle);
    let sha = null;
    try {
      const res = await sortir(`https://github.com/${repo}.git/info/refs?service=git-upload-pack`, { signal: AbortSignal.timeout(20000) }, { taille: 4 * 1048576 });
      if (res.ok) sha = commitDe(await res.text(), ref);
    } catch (err) { log.warn('registre', repo, 'commit illisible', err.message); }
    this.commits?.set(cle, sha);
    return sha;
  }

  /** La racine d'un dépôt GitHub, épinglée sur le commit de sa branche quand on le connaît. */
  async racineGithub(repo, ref, dir = '') {
    const sha = await this.commit(repo, ref);
    return { type: 'github', repo, ref, ...(sha ? { sha } : {}), dir };
  }

  async refreshMaintenant(actor) {
    this.errors = [];
    this.commits = new Map();
    let count = 0;
    const retires = [];
    // Une extension disparue de sa source (dépôt supprimé ou renommé, id
    // changé, retirée de l'index) quitte le catalogue — seulement quand la
    // source a été lue en entier, sans erreur : une panne ne vide rien.
    // Une extension installée garde sa ligne : ses redéploiements en ont besoin.
    const installees = new Set(this.db.all('SELECT ext_id FROM instances').map(r => r.ext_id));
    const elaguer = (label, vus) => {
      for (const r of this.db.all('SELECT id FROM catalog WHERE source=?', label)) {
        if (!vus.has(r.id) && !installees.has(r.id)) { this.db.run('DELETE FROM catalog WHERE id=? AND source=?', r.id, label); retires.push(r.id); }
      }
    };
    for (const r of this.db.all('SELECT DISTINCT source FROM catalog')) {
      if (r.source !== 'import' && !this.sources().includes(r.source)) elaguer(r.source, new Set());
    }
    for (const s of this.sources()) {
      const erreursAvant = this.errors.length;
      this.vus = new Set();
      try {
        const src = parseSource(s);
        if (src.type === 'github-user') {
          const { count: n, complet } = await this.refreshUser(src);
          count += n;
          if (complet && this.errors.length === erreursAvant) elaguer(src.label, this.vus);
          continue;
        }
        const root = src.type === 'local' ? { type: 'local', root: src.dir, dir: '' } : src.type === 'github' ? await this.racineGithub(src.repo, src.ref) : { type: 'url', base: src.base, dir: '' };
        if (src.type === 'local' && !fs.existsSync(path.join(src.dir, 'index.json'))) continue;
        let index;
        try { index = JSON.parse((await this.readFile(root, 'index.json')).toString('utf8')); }
        catch (err) {
          // Un dépôt GitHub sans index.json peut être un service seul, avec hub.json à la racine.
          if (src.type !== 'github') throw err;
          const m = JSON.parse((await this.readFile(root, 'hub.json')).toString('utf8'));
          index = { extensions: [{ id: m.id, manifest: 'hub.json' }] };
        }
        for (const e of index.extensions || []) {
          try { await this.load(src, root, e); count++; }
          catch (err) { this.errors.push({ source: s, id: e.id, error: err.message }); log.warn('registre', s, e.id, err.message); }
        }
        if (this.errors.length === erreursAvant) elaguer(src.label, this.vus);
      } catch (err) { this.errors.push({ source: s, error: err.message }); log.warn('registre', s, err.message); }
    }
    this.vus = null;
    this.commits = null;
    if (this.adaptation) for (const s of this.sources()) { try { this.adaptation.planifier(s, actor); } catch (err) { log.warn('adaptation', s, err.message); } }
    try { await this.suivreDemenagements(actor); } catch (err) { log.warn('registre', 'dépôts déplacés', err.message); }
    this.db.setSetting('registry_refreshed', Date.now());
    this.bus.emit('catalog', { count, retires });
    if (actor !== 'hub' || retires.length) this.audit.write(actor, 'catalogue.actualisé', null, { count, erreurs: this.errors.length, ...(retires.length ? { retires } : {}) });
    return { count, errors: this.errors };
  }

  // Tous les dépôts publics d'un compte GitHub : chaque dépôt qui porte un hub.json à la racine devient une extension.
  async refreshUser(src) {
    let repos = [], complet = true;
    try {
      for (let page = 1; page <= 10; page++) {
        const res = await sortir(`https://api.github.com/users/${src.owner}/repos?per_page=100&type=owner&page=${page}`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'hub' }, signal: AbortSignal.timeout(20000),
        });
        if (res.status === 403 || res.status === 429) throw new Error('limite de l’API GitHub atteinte');
        if (!res.ok) throw new Error(`liste des dépôts de ${src.owner} impossible (${res.status})`);
        const list = await res.json();
        repos.push(...list);
        if (list.length < 100) break;
      }
    } catch (err) {
      // Seul le LISTAGE consomme le quota de l'API. Lire un manifeste passe
      // par raw.githubusercontent, qui n'a pas cette limite. Un quota épuisé
      // ne doit donc empêcher que la découverte de NOUVEAUX dépôts, pas la
      // mise à jour de ceux qu'on connaît déjà — sinon une limite atteinte
      // fige tout le catalogue pendant une heure sans raison technique.
      repos = this.deposConnus(src);
      complet = false;
      if (!repos.length) throw err;
      this.errors.push({ source: src.label, error: `${err.message} — mise à jour des ${repos.length} dépôt(s) déjà connus ; un nouveau dépôt n'apparaîtra qu'au prochain essai.` });
      log.warn('registre', src.label, err.message, '→ repli sur les dépôts connus');
    }
    let count = 0;
    for (const r of repos) {
      if (r.fork || r.archived || r.disabled) continue;
      const root = await this.racineGithub(r.full_name, r.default_branch || 'main');
      let buf;
      try { buf = await this.readFile(root, 'hub.json'); } catch {
        // Pas de manifeste : un candidat à l'adaptation par l'IA, noté avec sa licence.
        if (this.adaptation) { try { this.adaptation.noter(src.label, r, root.sha); } catch (err) { log.warn('registre', r.full_name, 'adaptation', err.message); } }
        continue;
      }
      this.adaptation?.oublier(r.full_name);
      try {
        const m = JSON.parse(buf.toString('utf8'));
        await this.load(src, root, { id: m.id, repo: r.full_name, ref: root.ref, manifest: 'hub.json' }, buf);
        count++;
      } catch (err) { this.errors.push({ source: src.label, id: r.name, error: err.message }); log.warn('registre', src.label, r.name, err.message); }
    }
    // Les extensions adaptées par l'IA restent au catalogue tant que leur source le lit.
    if (this.adaptation) for (const id of this.adaptation.extensionsDe(src.label)) this.vus?.add(id);
    return { count, complet };
  }

  /**
   * Un dépôt déplacé ou renommé sur GitHub (compte passé à une organisation,
   * nouveau nom) : l'entrée d'un service installé, venue d'un registre que le
   * Hub ne lit plus, rejoint le registre où vit désormais son dépôt. GitHub en
   * fait la preuve : l'ancienne adresse du dépôt mène à la nouvelle, et seul
   * son propriétaire peut le transférer ou le renommer. Le service peut alors
   * passer à l'extension qui le remplace (même registre, `replaces`), comme
   * avant le déménagement. Rien n'est déplacé sans cette preuve.
   */
  async suivreDemenagements(actor = 'hub') {
    const lues = new Set(this.sources());
    const lignes = this.db.all('SELECT id, source, origin FROM catalog');
    const origine = l => { try { const o = JSON.parse(l.origin); return o?.type === 'github' && o.repo ? o : null; } catch { return null; } };
    const parDepot = new Map();
    for (const l of lignes) { const o = origine(l); if (o && lues.has(l.source)) parDepot.set(o.repo.toLowerCase(), l.source); }
    let n = 0;
    for (const l of lignes) {
      if (l.source === 'import' || lues.has(l.source)) continue;
      const o = origine(l);
      if (!o) continue;
      const actuel = await this.depotActuel(o.repo).catch(() => null);
      const cible = actuel && actuel.toLowerCase() !== o.repo.toLowerCase() ? parDepot.get(actuel.toLowerCase()) : null;
      if (!cible) continue;
      this.db.run('UPDATE catalog SET source=? WHERE id=? AND source=?', cible, l.id, l.source);
      this.audit?.write(actor, 'catalogue.dépôt_déplacé', l.id, { de: `${l.source} (${o.repo})`, vers: `${cible} (${actuel})` });
      n++;
    }
    return n;
  }

  /** Le nom actuel d'un dépôt GitHub (propriétaire/nom), redirections de renommage et de transfert suivies ; null s'il n'existe plus. */
  async depotActuel(repo) {
    if (!/^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(repo)) return null;
    const res = await sortir(`https://api.github.com/repos/${repo}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'hub' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { await res.body?.cancel(); return null; }
    const d = await res.json();
    return typeof d?.full_name === 'string' && /^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(d.full_name) ? d.full_name : null;
  }

  /**
   * Les dépôts de cette source déjà présents au catalogue.
   *
   * Leur origine a été enregistrée à la première découverte : on sait donc
   * où relire leur manifeste sans redemander la liste à GitHub.
   */
  deposConnus(src) {
    const out = new Map();
    for (const r of this.db.all('SELECT origin FROM catalog WHERE source=?', src.label)) {
      let o; try { o = JSON.parse(r.origin); } catch { continue; }
      if (o?.type === 'github' && o.repo) out.set(o.repo, { full_name: o.repo, default_branch: o.ref || 'main' });
    }
    return [...out.values()];
  }

  async load(src, root, e, preloaded) {
    let origin, file = e.manifest || 'hub.json';
    if (e.repo) origin = await this.racineGithub(e.repo, e.ref || 'main', path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file));
    else origin = { ...root, dir: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file) };
    const buf = preloaded || await this.readFile({ ...origin, dir: '' }, file);
    if (e.sha256 && sha256(buf) !== e.sha256) throw new Error('empreinte du manifeste différente de l’index');
    const manifest = JSON.parse(buf.toString('utf8'));
    this.check(manifest);
    if (manifest.id !== e.id) throw new Error(`id du manifeste (${manifest.id}) différent de l’index (${e.id})`);
    // La même extension dans deux sources (le registre livré avec le Hub et
    // son dépôt GitHub) : la plus récente reste. Avant, la dernière source lue
    // gagnait — Relay 2.1.2 du registre local masquait 2.2.0 publié.
    const deja = this.db.get('SELECT source, version, origin FROM catalog WHERE id=?', manifest.id);
    const adaptee = (() => { try { return JSON.parse(deja?.origin || '{}').type === 'adapte'; } catch { return false; } })();
    if (deja && !adaptee && deja.source !== src.label && deja.source !== 'import' && compareVersions(deja.version, manifest.version) > 0) return;
    this.vus?.add(manifest.id);
    this.db.run(`INSERT INTO catalog(id,source,version,manifest,origin,fetched) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source=excluded.source, version=excluded.version, manifest=excluded.manifest, origin=excluded.origin, fetched=excluded.fetched`,
    manifest.id, src.label, manifest.version, JSON.stringify(manifest), JSON.stringify({ ...origin, composeSha256: e.composeSha256 || null }), Date.now());
  }

  check(manifest) {
    const r = validateManifest(manifest);
    if (!r.valid) throw new HttpError(400, 'Manifeste invalide', r.errors.slice(0, 20));
    const ids = new Set();
    for (const k of ['triggers', 'actions', 'probes']) for (const x of manifest[k] || []) {
      if (ids.has(k + x.id)) throw new HttpError(400, `Identifiant en double dans ${k} : ${x.id}`);
      ids.add(k + x.id);
    }
    return true;
  }

  importManifest(manifest, actor) {
    this.check(manifest);
    this.db.run(`INSERT INTO catalog(id,source,version,manifest,origin,fetched) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source=excluded.source, version=excluded.version, manifest=excluded.manifest, origin=excluded.origin, fetched=excluded.fetched`,
    manifest.id, 'import', manifest.version, JSON.stringify(manifest), JSON.stringify({ type: 'import' }), Date.now());
    this.audit.write(actor, 'manifeste.importé', manifest.id, { version: manifest.version });
    this.bus.emit('catalog', {});
    return manifest;
  }

  list() {
    return this.db.all('SELECT * FROM catalog ORDER BY id').map(r => ({ id: r.id, source: r.source, version: r.version, fetched: r.fetched, manifest: JSON.parse(r.manifest), origin: JSON.parse(r.origin) }));
  }
  get(id) {
    const r = this.db.get('SELECT * FROM catalog WHERE id=?', id);
    if (!r) throw new HttpError(404, `Extension inconnue : ${id}`);
    return { id: r.id, source: r.source, version: r.version, manifest: JSON.parse(r.manifest), origin: JSON.parse(r.origin) };
  }
  /**
   * L'extension qui en remplace une autre (renommage) : déclarée par
   * `replaces`, venue du même registre que celle qu'elle remplace — un autre
   * registre ne peut pas s'emparer des données d'un service qui n'est pas à
   * lui — et jamais d'un manifeste importé.
   */
  remplacantDe(extId) {
    let ancien;
    try { ancien = this.get(extId); } catch { return null; }
    return this.list().find(e => e.id !== extId && e.source !== 'import' && e.origin?.type !== 'adapte' && e.source === ancien.source
      && (e.manifest.replaces || []).some(r => r.id === extId)) || null;
  }
  async composeFile(entry) {
    const o = entry.origin;
    if (o.type === 'import') throw new HttpError(400, 'Manifeste importé : installe-le en mode distant, ou publie-le dans un registre pour l’installer ici.');
    // Une adaptation : le Compose écrit par le Hub, gardé avec elle.
    if (o.type === 'adapte') { if (typeof o.compose !== 'string' || !o.compose) throw new HttpError(400, 'Adaptation sans fichier Compose : relance-la depuis Registres.'); return o.compose; }
    const buf = await this.readFile(o, entry.manifest.install.compose);
    if (o.composeSha256 && sha256(buf) !== o.composeSha256) throw new HttpError(400, 'Empreinte du fichier Compose différente de l’index');
    return buf.toString('utf8');
  }
}
