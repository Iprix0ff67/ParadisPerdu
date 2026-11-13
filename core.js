'use strict';
// Logique du launcher, sans dépendance à Electron (testable seule).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const UA = 'ParadisPerdu-Launcher';
const NAME_RE = /^[A-Za-z0-9_.\-]+\.pak$/;
const SHA_RE = /^[a-f0-9]{64}$/;

function friendly(e) {
  const m = String((e && (e.code || e.message)) || e) + ' ' + String((e && e.message) || '');
  if (/socket hang up|ECONNRESET|aborted/i.test(m)) return new Error('Connexion interrompue');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(m)) return new Error('Réseau indisponible');
  if (/ENOSPC/.test(m)) return new Error('Disque plein');
  if (/EACCES|EPERM/.test(m)) return new Error('Accès refusé au dossier des mods');
  return e;
}

function request(url, opts = {}) {
  const { timeout = 20000, redirects = 5, allowHttp = false } = opts;
  return new Promise((resolve, reject) => {
    if (!allowHttp && !url.startsWith('https:')) return reject(new Error('Connexion non sécurisée refusée'));
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Trop de redirections'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { ...opts, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Erreur HTTP ' + res.statusCode));
      }
      resolve(res);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Délai dépassé')));
    req.on('error', (e) => reject(friendly(e)));
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { res.destroy(new Error('Réponse trop grande')); return; }
      chunks.push(c);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function validateManifest(m, { allowedPrefix } = {}) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.mods)) throw new Error('Manifeste invalide');
  if (m.mods.length > 300) throw new Error('Manifeste invalide (trop de mods)');
  const seen = new Set();
  for (const x of m.mods) {
    if (!x || typeof x.name !== 'string' || !NAME_RE.test(x.name)) throw new Error('Nom de mod invalide dans le manifeste');
    if (seen.has(x.name)) throw new Error('Mod en double dans le manifeste : ' + x.name);
    seen.add(x.name);
    if (!Number.isInteger(x.size) || x.size <= 0) throw new Error('Taille invalide pour ' + x.name);
    if (typeof x.sha256 !== 'string' || !SHA_RE.test(x.sha256)) throw new Error('Empreinte invalide pour ' + x.name);
    if (typeof x.url !== 'string' || (allowedPrefix && !x.url.startsWith(allowedPrefix))) throw new Error('Lien refusé pour ' + x.name);
    if (typeof x.version !== 'string') x.version = String(x.version == null ? '' : x.version);
  }
  return m;
}

async function fetchManifest(url, opts = {}) {
  const text = await fetchText(url, opts);
  return validateManifest(JSON.parse(text), opts);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function downloadFile(url, dest, opts = {}) {
  const { expectedSha, expectedSize, onProgress } = opts;
  const res = await request(url, opts);
  const total = Number(res.headers['content-length']) || expectedSize || 0;
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let got = 0;
    let failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); res.destroy(); reject(friendly(e)); };
    res.setTimeout(30000, () => fail(new Error('Connexion interrompue')));
    res.on('data', (c) => { got += c.length; hash.update(c); if (onProgress) onProgress(got, total); });
    res.on('error', fail);
    res.on('aborted', () => fail(new Error('Connexion interrompue')));
    out.on('error', fail);
    out.on('finish', () => {
      if (failed) return;
      const sha = hash.digest('hex');
      if (expectedSize && got !== expectedSize) return fail(new Error('Fichier incomplet'));
      if (expectedSha && sha !== expectedSha) return fail(new Error('Fichier corrompu (empreinte différente)'));
      resolve(sha);
    });
    res.pipe(out);
  });
}

// ---- SCUM / Steam -------------------------------------------------------

function paths(root) {
  return {
    exe: path.join(root, 'SCUM', 'Binaries', 'Win64', 'SCUM.exe'),
    modsDir: path.join(root, 'SCUM', 'Content', 'Paks', '~mods'),
  };
}

function normalizeGameRoot(p) {
  if (!p) return null;
  if (fs.existsSync(paths(p).exe)) return p;
  if (fs.existsSync(path.join(p, 'Binaries', 'Win64', 'SCUM.exe'))) return path.dirname(p);
  return null;
}

function regSteamPath() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (e, out) => {
      if (e) return resolve(null);
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
      resolve(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

function parseLibraryFolders(text) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

async function detectGame(extraRoots = []) {
  const steamRoots = [await regSteamPath(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', ...extraRoots].filter(Boolean);
  const libs = new Set(steamRoots);
  for (const r of steamRoots) {
    try {
      const txt = fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      parseLibraryFolders(txt).forEach((l) => libs.add(l));
    } catch (_) { /* pas de fichier */ }
  }
  for (const l of libs) {
    const root = path.join(l, 'steamapps', 'common', 'SCUM');
    if (fs.existsSync(paths(root).exe)) return root;
  }
  return null;
}

function isRunning(exeName) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FI', 'IMAGENAME eq ' + exeName, '/NH'], { windowsHide: true }, (e, out) => {
      if (e) return resolve(false);
      resolve(String(out).toLowerCase().includes(exeName.toLowerCase()));
    });
  });
}

// ---- Mods ---------------------------------------------------------------

// installed[name] = { sha, size, mtimeMs } : mémoire des fichiers déjà vérifiés
async function statusOf(modsDir, mod, installed) {
  const file = path.join(modsDir, mod.name);
  let st;
  try { st = fs.statSync(file); } catch (_) { return 'new'; }
  if (st.size !== mod.size) return 'old';
  const rec = installed[mod.name];
  if (rec && rec.sha === mod.sha256 && rec.size === st.size && Math.abs(rec.mtimeMs - st.mtimeMs) < 1) return 'ok';
  const sha = await sha256File(file);
  if (sha !== mod.sha256) return 'old';
  installed[mod.name] = { sha, size: st.size, mtimeMs: st.mtimeMs };
  return 'ok';
}

function recordInstalled(modsDir, mod, installed) {
  const st = fs.statSync(path.join(modsDir, mod.name));
  installed[mod.name] = { sha: mod.sha256, size: st.size, mtimeMs: st.mtimeMs };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeFile(file, retries, delay) {
  for (let i = 0; i <= retries; i++) {
    try { fs.unlinkSync(file); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (i === retries) return false;
      await sleep(delay);
    }
  }
  return false;
}

async function removeMods(modsDir, names, { retries = 5, delay = 1000 } = {}) {
  let failed = [];
  for (const n of names) {
    if (!NAME_RE.test(n)) continue;
    const ok = await removeFile(path.join(modsDir, n), retries, delay);
    await removeFile(path.join(modsDir, n + '.part'), 0, 0);
    if (!ok) failed.push(n);
  }
  try { fs.rmdirSync(modsDir); } catch (_) { /* dossier non vide ou absent : on le laisse */ }
  return failed;
}

module.exports = {
  request, fetchText, fetchManifest, validateManifest, sha256File, downloadFile,
  paths, normalizeGameRoot, parseLibraryFolders, detectGame, isRunning,
  statusOf, recordInstalled, removeMods, NAME_RE,
};
