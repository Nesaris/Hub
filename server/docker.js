// Pilotage de Docker par la CLI `docker compose` (DOCKER_HOST pointe vers le proxy de socket).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { HttpError } from './util/common.js';

// La CLI ne reçoit que de quoi joindre le démon. Le reste de l'environnement
// du Hub (réglages, secrets du socle) n'a rien à faire dans l'interpolation
// « ${…} » d'un fichier Compose venu d'un registre.
const GARDEES = /^(PATH|HOME|TMPDIR|DOCKER_[A-Z0-9_]+|COMPOSE_[A-Z0-9_]+)$/;
export function environnementDocker(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => GARDEES.test(k)));
}

export function run(args, { input, timeout = 300000, cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn('docker', args, { cwd, env: { ...environnementDocker(), ...env } }); }
    catch (e) { reject(new HttpError(503, 'Docker indisponible : ' + e.message)); return; }
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new HttpError(504, `docker ${args[0]} : délai dépassé`)); }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(new HttpError(503, e.code === 'ENOENT' ? 'La commande docker est absente de ce système.' : e.message)); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out.trim());
      else reject(new HttpError(502, `docker ${args.slice(0, 2).join(' ')} a échoué : ${(err || out).trim().split('\n').slice(-3).join(' ')}`));
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export const docker = {
  async available() { try { await run(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 }); return true; } catch { return false; } },
  async ensureNetwork(name) {
    try { await run(['network', 'inspect', name], { timeout: 10000 }); }
    catch { await run(['network', 'create', name], { timeout: 20000 }); }
  },
  async imageExists(ref) { try { await run(['image', 'inspect', ref, '--format', '{{.Id}}'], { timeout: 15000 }); return true; } catch { return false; } },
  pullImage: ref => run(['pull', ref], { timeout: 900000 }),
  // Construction depuis une archive (contexte sur l'entrée standard), par le
  // constructeur classique : le proxy de socket n'ouvre que POST /build.
  construire: (ref, contexte, cible = null) => run(['build', '-t', ref, ...(cible ? ['--target', cible] : []), '-'], { input: contexte, timeout: 1800000, env: { DOCKER_BUILDKIT: '0' } }),
  /** Pour chaque image de la pile qui tourne : l'identifiant de l'image réellement utilisée. */
  async imagesEnService(project) {
    const out = new Map();
    try {
      const ids = (await run(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`], { timeout: 15000 })).split(/\s+/).filter(Boolean);
      if (!ids.length) return out;
      const lignes = (await run(['inspect', '--format', '{{.Config.Image}} {{.Image}}', ...ids], { timeout: 15000 })).split('\n').filter(Boolean);
      for (const l of lignes) { const [ref, id] = l.trim().split(/\s+/); if (ref && id) out.set(ref, id); }
    } catch { /* pile arrêtée : rien à comparer */ }
    return out;
  },
  /** L'adresse IPv4 d'un conteneur sur un réseau donné ('' s'il n'y est pas). */
  async ipSurReseau(conteneur, reseau) {
    const ip = (await run(['inspect', '--format', `{{with index .NetworkSettings.Networks "${reseau}"}}{{.IPAddress}}{{end}}`, conteneur], { timeout: 15000 })).trim();
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : '';
  },
  /** Les ports d'hôte publiés par les conteneurs de la machine (« 0.0.0.0:8190->8140/tcp »). */
  async portsPublies() {
    const sortie = await run(['ps', '--format', '{{.Ports}}'], { timeout: 15000 });
    return new Set([...sortie.matchAll(/:(\d+)->/g)].map(m => Number(m[1])));
  },
  async imageId(ref) { try { return (await run(['image', 'inspect', ref, '--format', '{{.Id}}'], { timeout: 15000 })).trim(); } catch { return null; } },
  up: (project, file) => run(['compose', '-p', project, '-f', file, 'up', '-d', '--remove-orphans'], { timeout: 900000 }),
  pull: (project, file) => run(['compose', '-p', project, '-f', file, 'pull', '--policy', 'missing'], { timeout: 900000 }),
  down: (project, file, volumes) => run(['compose', '-p', project, '-f', file, 'down', ...(volumes ? ['-v'] : [])], { timeout: 300000 }),
  config: (file) => run(['compose', '-f', file, 'config', '-q'], { timeout: 30000 }),
  async volumeExiste(nom) { try { await run(['volume', 'inspect', nom], { timeout: 15000 }); return true; } catch { return false; } },
  supprimerVolume: nom => run(['volume', 'rm', nom], { timeout: 60000 }),
  async imageDuConteneur(conteneur) { return (await run(['inspect', '--format', '{{.Image}}', conteneur], { timeout: 15000 })).trim() || null; },
  /**
   * Le contenu d'un volume recopié dans un autre (créé au passage),
   * propriétaires, droits et dates compris : un conteneur jetable, sans
   * réseau, système en lecture seule, l'original monté en lecture seule, et
   * les seules capacités qu'il faut pour écrire des fichiers qui ne sont pas
   * à root.
   */
  async copierVolume(de, vers, image) {
    const nom = `hub-copie-${crypto.randomBytes(4).toString('hex')}`;
    await run(['run', '-d', '--name', nom, '--network', 'none', '--read-only', '--user', '0:0',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true',
      '-v', `${de}:/de:ro`, '-v', `${vers}:/vers`, '--entrypoint', 'sh', image, '-c', 'cp -a /de/. /vers/ 2>&1'], { timeout: 120000 });
    try {
      const code = (await run(['wait', nom], { timeout: 1800000 })).trim();
      if (code !== '0') {
        let sortie = '';
        try { sortie = (await run(['logs', '--tail', '3', nom], { timeout: 15000 })).split('\n').pop(); } catch { /* journal illisible : le code suffit */ }
        throw new HttpError(502, `Copie de ${de} vers ${vers} impossible (code ${code})${sortie ? ` : ${sortie}` : ''}.`);
      }
    } finally {
      try { await run(['rm', '-f', nom], { timeout: 30000 }); } catch { /* conteneur déjà parti */ }
    }
  },
  logs: (project, file, tail = 200) => run(['compose', '-p', project, '-f', file, 'logs', '--no-color', '--tail', String(tail)], { timeout: 30000 }),
};
