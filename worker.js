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
        // ---- datos globales de la consola de desarrollador (de todas las cuentas) ----
        db.prepare('CREATE TABLE IF NOT EXISTS g_arenas (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, acc TEXT NOT NULL, sum TEXT NOT NULL, body TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS g_arenas_ts ON g_arenas (ts DESC)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_species (line TEXT PRIMARY KEY, sprite TEXT, gen INTEGER DEFAULT 0, genManual INTEGER DEFAULT 0, arenas INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, kos INTEGER DEFAULT 0, faints INTEGER DEFAULT 0, elims INTEGER DEFAULT 0, caps INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, dealt INTEGER DEFAULT 0, taken INTEGER DEFAULT 0, bestKos INTEGER DEFAULT 0, raids INTEGER DEFAULT 0, raidWins INTEGER DEFAULT 0, bosses INTEGER DEFAULT 0, last INTEGER DEFAULT 0)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_saves (id TEXT PRIMARY KEY, acc TEXT NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_seen (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL)'),
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

const NUM = ['gen', 'genManual', 'arenas', 'wins', 'kos', 'faints', 'elims', 'caps', 'ms', 'dealt', 'taken', 'raids', 'raidWins', 'bosses'];
const num = v => (Number.isFinite(v) ? Math.max(0, Math.min(1e12, Math.round(v))) : 0);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Un registro global: { rid, arena?, ops?, saves? }. Es idempotente por 'rid' (el cliente puede reintentar).
async function ingest(db, h, b) {
    if (!isObj(b) || typeof b.rid !== 'string' || b.rid.length > 64) return { error: 'registro no válido' };
    if (await db.prepare('SELECT 1 FROM g_seen WHERE rid = ?1').bind(b.rid).first()) return { ok: true, dup: true };
    const acc = h.slice(0, 8), now = Date.now(), st = [];
    if (isObj(b.a) && typeof b.a.id === 'string' && typeof b.a.sum === 'string' && typeof b.a.body === 'string' && b.a.sum.length < 1500000 && b.a.body.length < 1500000) {
        st.push(db.prepare('INSERT OR REPLACE INTO g_arenas (k, ts, acc, sum, body) VALUES (?1, ?2, ?3, ?4, ?5)').bind(acc + ':' + b.a.id.slice(0, 20), num(b.a.ts) || now, acc, b.a.sum, b.a.body));
    }
    if (isObj(b.arena) && typeof b.arena.id === 'string') {
        const a = b.arena, full = JSON.stringify(a);
        const lite = JSON.parse(full); delete lite.ind; (lite.players || []).forEach(p => { if (p) delete p.ind; });
        let body = full; if (body.length > 1500000) body = JSON.stringify(lite);
        st.push(db.prepare('INSERT OR REPLACE INTO g_arenas (k, ts, acc, sum, body) VALUES (?1, ?2, ?3, ?4, ?5)').bind(acc + ':' + a.id.slice(0, 20), num(a.ts) || now, acc, JSON.stringify(lite), body));
    }
    if (isObj(b.ops)) {
        for (const line of Object.keys(b.ops).slice(0, 200)) {
            const o = b.ops[line]; if (!isObj(o) || line.length > 60) continue;
            const add = isObj(o.add) ? o.add : {}, mx = isObj(o.max) ? o.max : {};
            const cols = ['line', 'sprite', ...NUM, 'bestKos', 'last'], vals = [line, typeof o.sprite === 'string' ? o.sprite.slice(0, 400) : '', ...NUM.map(k => num(add[k])), num(mx.bestKos), now];
            const upd = NUM.map(k => k + ' = ' + k + ' + excluded.' + k).concat(['bestKos = MAX(bestKos, excluded.bestKos)', "sprite = CASE WHEN sprite = '' OR sprite IS NULL THEN excluded.sprite ELSE sprite END", 'last = excluded.last']).join(', ');
            st.push(db.prepare('INSERT INTO g_species (' + cols.join(',') + ') VALUES (' + cols.map((_, i) => '?' + (i + 1)).join(',') + ') ON CONFLICT(line) DO UPDATE SET ' + upd).bind(...vals));
        }
    }
    if (Array.isArray(b.saves)) {
        for (const e of b.saves.slice(0, 10)) if (isObj(e) && typeof e.id === 'string') st.push(db.prepare('INSERT OR REPLACE INTO g_saves (id, acc, updated, body) VALUES (?1, ?2, ?3, ?4)').bind(acc + ':' + e.id.slice(0, 24), acc, now, JSON.stringify(e)));
    }
    st.push(db.prepare('INSERT OR IGNORE INTO g_seen (rid, ts) VALUES (?1, ?2)').bind(b.rid, now));
    if (Math.random() < 0.02) st.push(db.prepare('DELETE FROM g_seen WHERE ts < ?1').bind(now - 7 * 864e5));
    await db.batch(st);
    return { ok: true };
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
            // ---- consola de desarrollador GLOBAL ----
            if (route === '/api/g/record' && req.method === 'POST') {
                const t = await req.text(); if (t.length > 3e6) return reply({ error: 'demasiado grande' }, 413);
                let b; try { b = JSON.parse(t); } catch (e) { return reply({ error: 'json no válido' }, 400); }
                const r = await ingest(db, h, b); return reply(r, r.error ? 400 : 200);
            }
            if (route === '/api/g/dev' && req.method === 'GET') {
                const lim = Math.max(1, Math.min(200, +url.searchParams.get('limit') || 100));
                const [ar, sp, sv, ct] = await db.batch([
                    db.prepare('SELECT k, acc, sum FROM g_arenas ORDER BY ts DESC LIMIT ?1').bind(lim),
                    db.prepare('SELECT * FROM g_species'),
                    db.prepare('SELECT acc, body FROM g_saves ORDER BY updated DESC LIMIT 500'),
                    db.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM g_arenas) AS arenas'),
                ]);
                const species = {}; for (const r of sp.results) { const { line, ...rest } = r; species[line] = rest; }
                const arenas = ar.results.map(r => '{"_k":' + JSON.stringify(r.k) + ',"_acc":"' + r.acc + '",' + r.sum.slice(1)).join(',');
                const saves = sv.results.map(r => '{"_acc":"' + r.acc + '",' + r.body.slice(1)).join(',');
                return reply('{"totals":' + JSON.stringify(ct.results[0]) + ',"species":' + JSON.stringify(species) + ',"arenas":[' + arenas + '],"saves":[' + saves + ']}');
            }
            if (route === '/api/g/arena' && req.method === 'GET') {
                const row = await db.prepare('SELECT body FROM g_arenas WHERE k = ?1').bind(url.searchParams.get('k') || '').first();
                return row ? reply(row.body) : reply({ error: 'no existe' }, 404);
            }
            if (route === '/api/g/clear' && req.method === 'POST') {
                const key = env.ADMIN_KEY;
                if (!key) return reply({ error: 'falta configurar ADMIN_KEY en Cloudflare' }, 403);
                const b = await req.json().catch(() => ({}));
                if (b.key !== key) return reply({ error: 'clave incorrecta' }, 403);
                if (b.what === 'arenas') await db.prepare('DELETE FROM g_arenas').run();
                else if (b.what === 'species') await db.prepare('DELETE FROM g_species').run();
                else return reply({ error: 'qué borrar' }, 400);
                return reply({ ok: true });
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
