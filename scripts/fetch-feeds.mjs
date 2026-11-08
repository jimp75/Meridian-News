// Récupère côté serveur (GitHub Actions) tous les flux RSS et cours de bourse
// listés dans index.html, et les enregistre dans news.json (même origine que la page => pas de CORS).
import fs from 'node:fs';
import vm from 'node:vm';

const file = ['index.html', 'meridian-news.html'].find(f => fs.existsSync(f));
if (!file) throw new Error('index.html introuvable');
const html = fs.readFileSync(file, 'utf8');

// Réutilise la config de la page (une seule source de vérité)
const a = html.indexOf('const GN =');
const b = html.indexOf('const PROXIES');
if (a < 0 || b < 0) throw new Error('Bloc de configuration introuvable dans la page');
const ctx = { encodeURIComponent };
vm.createContext(ctx);
vm.runInContext(html.slice(a, b).replace(/\bconst\b/g, 'var'), ctx);

const urls = new Set();
for (const s of ctx.DEFAULT_SOURCES) urls.add(s.url);
for (const [, sym] of ctx.MARKETS) {
  urls.add('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d');
  const id = ctx.STOOQ[sym];
  if (id) urls.add('https://stooq.com/q/l/?s=' + encodeURIComponent(id) + '&f=sd2t2ohlc&h&e=csv');
}

// Sources ajoutées par l'utilisateur et enregistrées dans sources.json
if (fs.existsSync('sources.json')) {
  try {
    for (const s of JSON.parse(fs.readFileSync('sources.json', 'utf8')))
      if (s && /^https?:\/\//.test(s.url)) urls.add(s.url);
  } catch (e) { console.log('sources.json illisible :', e.message); }
}

// Garde les 25 premiers articles (comme la page) pour limiter la taille
function trim(x) {
  if (!x.trimStart().startsWith('<')) return x;
  const re = /<(item|entry)[\s>]/g;
  let m, n = 0;
  while ((m = re.exec(x))) {
    if (++n === 26) {
      const head = x.slice(0, m.index);
      return head + (/<feed[\s>]/.test(head) ? '</feed>' : '</channel></rss>');
    }
  }
  return x;
}

async function get(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MeridianNewsBot/1.0; +https://github.com)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/csv, */*'
      }
    });
    if (!r.ok) return [url, null, 'HTTP ' + r.status];
    const t = await r.text();
    return t.length > 50 ? [url, trim(t), null] : [url, null, 'vide'];
  } catch (e) { return [url, null, String(e.message || e)]; }
}

const list = [...urls], data = {}, failed = [];
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < list.length) {
    const [u, t, err] = await get(list[i++]);
    if (t) data[u] = t; else failed.push(`${u} -> ${err}`);
  }
}));

fs.writeFileSync('news.json', JSON.stringify({ updated: new Date().toISOString(), data }));
console.log(`OK ${Object.keys(data).length}/${list.length}`);
failed.forEach(f => console.log('ÉCHEC', f));
if (!Object.keys(data).length) process.exit(1);
