// Requêtes sortantes (manuel, SEC-CSRF-004) : les adresses de la vérification
// du manuel sont toutes refusées, une redirection vers le réseau interne aussi.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.HUB_LOG_LEVEL = 'error';
const { sortir, classer, lireEntree, destinationTcp, configurer } = await import('../server/sortie.js');

let serveur, port, cible, portCible;
before(async () => {
  // 127.0.0.1 : autorisé dans ces essais. 127.0.0.2 : interne, jamais autorisé.
  cible = http.createServer((req, res) => res.end('interne'));
  await new Promise(r => cible.listen(0, '127.0.0.2', r));
  portCible = cible.address().port;
  serveur = http.createServer((req, res) => {
    if (req.url === '/vers-interne') { res.writeHead(302, { Location: `http://127.0.0.2:${portCible}/` }); return res.end(); }
    if (req.url === '/vers-metadonnees') { res.writeHead(307, { Location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/vers-soi') { res.writeHead(301, { Location: '/ok' }); return res.end(); }
    if (req.url === '/gros') { res.writeHead(200); return res.end(Buffer.alloc(2 * 1048576, 97)); }
    if (req.url === '/lent') return setTimeout(() => res.end('tard'), 2000);
    if (req.url === '/echo') { let b = ''; req.on('data', c => { b += c; }); return req.on('end', () => res.end(JSON.stringify({ methode: req.method, corps: b, auth: req.headers.authorization || null }))); }
    res.end('ok');
  });
  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  port = serveur.address().port;
  configurer({ internes: () => ['127.0.0.1'] });
});
after(() => { serveur.close(); cible.close(); configurer({ internes: () => [] }); });

test('sortie : les adresses de la vérification du manuel sont refusées', async () => {
  configurer({ internes: () => [] });
  try {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:6379', 'http://127.0.0.1', 'http://[::1]/', 'http://[::ffff:169.254.169.254]/', 'http://100.100.100.200/', 'http://0.0.0.0/'])
      await assert.rejects(sortir(url, {}, { delai: 3000 }), e => e.status === 403, url);
    // Un nom interne : refusé s'il se résout vers le réseau privé, injoignable sinon.
    await assert.rejects(sortir('http://internal-service/', {}, { delai: 3000 }));
  } finally { configurer({ internes: () => ['127.0.0.1'] }); }
});

test('sortie : les métadonnées restent refusées même autorisées ou saisies par un administrateur', async () => {
  await assert.rejects(sortir('http://169.254.169.254/', {}, { confiance: 'admin' }), /toujours refusée/);
  await assert.rejects(sortir('http://[fd00:ec2::254]/', {}, { confiance: 'admin' }), /toujours refusée/);
  assert.throws(() => lireEntree('169.254.0.0/16'), /seules les adresses privées/);
  assert.throws(() => lireEntree('0.0.0.0/0'), /trop large/);
  assert.throws(() => lireEntree('8.8.8.8'), /seules les adresses privées/);
  assert.equal(lireEntree('192.168.10.0/24').texte, '192.168.10.0/24');
  assert.equal(lireEntree('NAS.lan').texte, 'nas.lan');
});

test('sortie : un site public exige https ; schémas autres que http(s) refusés', async () => {
  await assert.rejects(sortir('http://8.8.8.8/'), /https exigé/);
  for (const url of ['file:///etc/passwd', 'ftp://exemple.org/', 'gopher://127.0.0.1:6379/_', 'http://ana:secret@127.0.0.1/'])
    await assert.rejects(sortir(url), e => e.status === 403, url);
});

test('sortie : destination interne autorisée joignable, redirection vers l’interne non autorisé refusée', async () => {
  assert.equal(await (await sortir(`http://127.0.0.1:${port}/`)).text(), 'ok');
  assert.equal(await (await sortir(`http://127.0.0.1:${port}/vers-soi`)).text(), 'ok');
  await assert.rejects(sortir(`http://127.0.0.1:${port}/vers-interne`), /destination interne non autorisée : 127\.0\.0\.2/);
  await assert.rejects(sortir(`http://127.0.0.1:${port}/vers-metadonnees`), /toujours refusée/);
  // Sans suivre : la redirection est rendue telle quelle, rien n'est joint.
  const r = await sortir(`http://127.0.0.1:${port}/vers-interne`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  await assert.rejects(sortir(`http://127.0.0.1:${port}/vers-interne`, { redirect: 'error' }), /redirection refusée/);
  await assert.rejects(sortir(`http://127.0.0.2:${portCible}/`), /non autorisée/);
  assert.equal(await (await sortir(`http://127.0.0.2:${portCible}/`, {}, { autoriser: ['127.0.0.2'] })).text(), 'interne');
});

test('sortie : taille et délai bornés ; corps et en-têtes transmis comme fetch', async () => {
  const gros = await sortir(`http://127.0.0.1:${port}/gros`, {}, { taille: 1048576 });
  await assert.rejects(gros.arrayBuffer(), /trop volumineuse|terminated/);
  await assert.rejects(sortir(`http://127.0.0.1:${port}/lent`, {}, { delai: 200 }), e => e.name === 'TimeoutError');
  const echo = await (await sortir(`http://127.0.0.1:${port}/echo`, { method: 'POST', headers: { Authorization: 'Bearer x' }, body: JSON.stringify({ a: 1 }) })).json();
  assert.deepEqual(echo, { methode: 'POST', corps: '{"a":1}', auth: 'Bearer x' });
  const f = new FormData(); f.set('champ', 'valeur');
  const multi = await (await sortir(`http://127.0.0.1:${port}/echo`, { method: 'POST', body: f })).json();
  assert.match(multi.corps, /name="champ"\r\n\r\nvaleur/);
});

test('sortie : connexion TCP brute soumise à la même règle', async () => {
  assert.equal(await destinationTcp('127.0.0.1'), '127.0.0.1');
  await assert.rejects(destinationTcp('127.0.0.2'), /non autorisée/);
  await assert.rejects(destinationTcp('169.254.169.254'), /toujours refusée/);
  // Un port public se teste sans https : ce n'est pas du HTTP.
  assert.equal(await destinationTcp('1.1.1.1'), '1.1.1.1');
});

test('sortie : classement des adresses, IPv4 glissées dans IPv6 comprises', () => {
  for (const [ip, attendu] of [['10.1.2.3', 'interne'], ['172.31.0.1', 'interne'], ['100.64.0.1', 'interne'], ['::1', 'interne'], ['fd12::1', 'interne'],
    ['::ffff:a00:1', 'interne'], ['169.254.169.254', 'interdite'], ['fe80::1', 'interdite'], ['224.0.0.1', 'interdite'], ['2001:db8::1', 'interdite'],
    ['::ffff:a9fe:a9fe', 'interdite'], ['1.1.1.1', 'publique'], ['2606:4700::1111', 'publique']]) assert.equal(classer(ip), attendu, ip);
});
