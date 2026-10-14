// PokeArena en Cloudflare Workers + D1 (plan gratis). Guarda las partidas como texto sin parsearlas
// (el plan gratis solo da 10 ms de CPU por petición) troceadas en filas de D1.
const CHUNK = 400000, SLOTS = ['1', '2', '3'], MAX_BODY = 12e6;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
const reply = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

let ready = null;
function init(db) {
    return ready || (ready = db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS accounts (h TEXT PRIMARY KEY, created INTEGER)'),
        db.prepare('CREATE TABLE IF NOT EXISTS blobs (h TEXT NOT NULL, k TEXT NOT NULL, i INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (h, k, i))'),
    ]).catch(e => { ready = null; throw e; }));
}
async function readKey(db, h, k) {
    const { results } = await db.prepare('SELECT part FROM blobs WHERE h = ?1 AND k = ?2 ORDER BY i').bind(h, k).all();
    return results.length ? results.map(r => r.part).join('') : null;
}
async function writeKey(db, h, k, text) {
    const st = [db.prepare('DELETE FROM blobs WHERE h = ?1 AND k = ?2').bind(h, k)];
    for (let i = 0, n = 0; i < text.length || n === 0; i += CHUNK, n++) st.push(db.prepare('INSERT INTO blobs (h, k, i, part) VALUES (?1, ?2, ?3, ?4)').bind(h, k, n, text.slice(i, i + CHUNK)));
    await db.batch(st);
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const route = url.pathname.replace(/\/+$/, '');
        if (route === '/api/health') return reply({ ok: true, app: 'PokeArena' });
        try {
            const db = env.DB; await init(db);
            if (route === '/api/session' && req.method === 'POST') {
                const token = hex(crypto.getRandomValues(new Uint8Array(24)));
                await db.prepare('INSERT INTO accounts (h, created) VALUES (?1, ?2)').bind(await sha(token), Date.now()).run();
                return reply({ token });
            }
            const m = /^Bearer ([a-f0-9]{48})$/.exec(req.headers.get('Authorization') || '');
            if (!m) return reply({ error: 'cuenta no válida' }, 401);
            const h = await sha(m[1]);
            if (!(await db.prepare('SELECT 1 FROM accounts WHERE h = ?1').bind(h).first())) return reply({ error: 'cuenta no válida' }, 401);

            if (route === '/api/state' && req.method === 'GET') {
                const { results } = await db.prepare('SELECT k, i, part FROM blobs WHERE h = ?1 ORDER BY k, i').bind(h).all();
                const by = {};
                for (const r of results) by[r.k] = (by[r.k] || '') + r.part;
                const slots = SLOTS.filter(n => by['slot' + n]).map(n => '"' + n + '":' + by['slot' + n]).join(',');
                return reply('{"fresh":' + (results.length ? 'false' : 'true') + ',"settings":' + (by.settings || '{}') + ',"slots":{' + slots + '}}');
            }
            if (route === '/api/settings' && req.method === 'PUT') {
                const t = await req.text();
                if (t.length > MAX_BODY || t[0] !== '{') return reply({ error: 'ajustes no válidos' }, 400);
                await writeKey(db, h, 'settings', t); return reply({ ok: true });
            }
            const s = /^\/api\/slot\/([123])$/.exec(route);
            if (s) {
                if (req.method === 'PUT') {
                    const t = await req.text();
                    if (t.length > MAX_BODY || t[0] !== '{' || !t.includes('"data"')) return reply({ error: 'partida no válida' }, 400);
                    await writeKey(db, h, 'slot' + s[1], t); return reply({ ok: true });
                }
                if (req.method === 'DELETE') { await db.prepare('DELETE FROM blobs WHERE h = ?1 AND k = ?2').bind(h, 'slot' + s[1]).run(); return reply({ ok: true }); }
            }
            return reply({ error: 'no existe' }, 404);
        } catch (e) { return reply({ error: 'error del servidor' }, 500); }
    },
};
