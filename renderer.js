'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const lab = { ok: 'À jour', old: 'Mise à jour', new: 'À installer', dl: 'Téléchargement…' };
const HELP = { join: 'Les mods restent installés.', session: 'Mods supprimés à la fermeture du jeu.' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' Go' : Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' Mo');
let S = null;

function go(v) {
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  $$('.nav button[data-v]').forEach((b) => (b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
}

function render(s) {
  if (!s) return;
  S = s;
  const ok = s.mods.filter((m) => m.status === 'ok').length;

  $('#mods').innerHTML = s.mods.map((m) =>
    `<li><span>${esc(m.name)}<em>v${esc(m.version)} · ${fmt(m.size)}</em></span><span class="st ${m.status}">${lab[m.status] || ''}</span></li>`).join('')
    || '<li><span>Aucun mod chargé</span></li>';
  $('#count').textContent = !s.hasManifest ? '' : s.pending ? s.pending + ' à télécharger' : 'tout est à jour';

  $('#gameState').textContent = s.gameOk ? 'JEU DÉTECTÉ' : 'JEU INTROUVABLE';
  $('#gameState').style.color = s.gameOk ? '' : '#ff8a7a';
  $('#stMods').textContent = s.hasManifest ? s.mods.length : '-';
  $('#stOk').textContent = s.hasManifest ? ok + ' / ' + s.mods.length : '-';
  $('#stDl').textContent = s.hasManifest ? (s.pending ? fmt(s.pendingBytes) : 'rien') : '-';

  $$('.seg button').forEach((b) => {
    b.setAttribute('aria-checked', b.dataset.m === s.mode);
    b.disabled = s.busy || s.playing;
  });
  $('#help').textContent = HELP[s.mode];

  const b = $('#play');
  let st; let txt; let dis = false;
  if (!s.ready) { st = 'busy'; txt = 'Chargement…'; dis = true; }
  else if (!s.hasManifest) { st = 'retry'; txt = 'Réessayer'; }
  else if (!s.gameOk) { st = 'find'; txt = 'Localiser SCUM'; }
  else if (s.busy) { st = 'busy'; txt = 'Téléchargement…'; dis = true; }
  else if (s.playing) { st = 'busy'; txt = 'En jeu'; dis = true; }
  else if (s.pending) { st = 'update'; txt = 'Mettre à jour'; }
  else { st = 'play'; txt = 'Jouer'; }
  b.dataset.s = st; b.textContent = txt; b.disabled = dis;

  const nw = s.news;
  if (nw) {
    $('#newsTitle').textContent = nw.title || '';
    $('#newsText').textContent = nw.text || '';
    $('#newsDate').textContent = nw.date || '';
  }

  $('#path').value = s.gamePath || 'Non trouvé';
  $('#modsDir').value = s.modsDir || '';

  const msg = $('#msg');
  msg.classList.toggle('err', !!s.error);
  let pct = 0;
  if (s.error) msg.textContent = s.error;
  else if (s.progress) { msg.textContent = s.progress.msg; pct = s.progress.pct; }
  else if (s.playing) { msg.textContent = 'SCUM lancé (' + s.args.join(' ') + ')' + (s.mode === 'session' ? ', mods supprimés à la fermeture' : ''); pct = 100; }
  else if (!s.ready) msg.textContent = 'Chargement…';
  else if (!s.gameOk) msg.textContent = 'Choisissez le dossier de SCUM dans les paramètres';
  else if (s.pending) msg.textContent = 'Mises à jour disponibles';
  else { msg.textContent = 'Prêt à jouer !'; pct = 100; }
  $('#pb').style.width = pct + '%';
  $('#chk').style.visibility = (s.ready && s.gameOk && s.hasManifest && !s.pending && !s.busy && !s.error) ? 'visible' : 'hidden';
}

$('#play').addEventListener('click', () => {
  const a = $('#play').dataset.s;
  if (a === 'find') go('set');
  else if (a === 'retry') api.init().then(render);
  else if (a === 'update') api.update();
  else if (a === 'play') api.play();
});
$$('.seg button').forEach((b) => b.addEventListener('click', () => api.setMode(b.dataset.m)));
$$('[data-v]').forEach((b) => b.addEventListener('click', () => go(b.dataset.v)));
$$('[data-ext]').forEach((b) => b.addEventListener('click', () => api.ext(b.dataset.ext)));
$('#footDiscord').addEventListener('click', () => api.ext('discord'));
$('#footDiscord').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') api.ext('discord'); });
$('#detect').addEventListener('click', async () => {
  $('#setMsg').textContent = 'Recherche en cours…';
  const s = await api.detect(); render(s);
  $('#setMsg').textContent = s.gameOk ? 'SCUM trouvé dans votre bibliothèque Steam.' : '';
});
$('#pick').addEventListener('click', async () => {
  const s = await api.pick(); render(s);
  $('#setMsg').textContent = s.gameOk ? 'Dossier enregistré.' : '';
});
$('#wmin').addEventListener('click', () => api.win('min'));
$('#wclose').addEventListener('click', () => api.win('close'));

api.onState(render);
api.init().then(render);
