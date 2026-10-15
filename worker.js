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
        db.prepare('CREATE TABLE IF NOT EXISTS g_species (line TEXT PRIMARY KEY, sprite TEXT, gen INTEGER DEFAULT 0, genManual INTEGER DEFAULT 0, apps INTEGER DEFAULT 0, arenas INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, kos INTEGER DEFAULT 0, faints INTEGER DEFAULT 0, elims INTEGER DEFAULT 0, caps INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, dealt INTEGER DEFAULT 0, taken INTEGER DEFAULT 0, bestKos INTEGER DEFAULT 0, raids INTEGER DEFAULT 0, raidWins INTEGER DEFAULT 0, bosses INTEGER DEFAULT 0, last INTEGER DEFAULT 0)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_saves (id TEXT PRIMARY KEY, acc TEXT NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL, pc TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_saves_del (id TEXT PRIMARY KEY)'), // filas del registro de partidas eliminadas a mano: no se vuelven a crear
        db.prepare('CREATE TABLE IF NOT EXISTS g_seen (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL)'),
        // ---- arena multijugador: salas, miembros y pokémon aportados ----
        db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, host TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, result TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS room_members (code TEXT NOT NULL, acc TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, avatar TEXT, PRIMARY KEY (code, acc))'),
        db.prepare('CREATE TABLE IF NOT EXISTS room_picks (code TEXT NOT NULL, acc TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (code, acc, n))'),
        // última instantánea de la arena que publica el anfitrión (la simula él; el resto de jugadores la ve en directo)
        db.prepare('CREATE TABLE IF NOT EXISTS room_snap (code TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)'),
    ]).then(() => db.prepare('ALTER TABLE g_species ADD COLUMN apps INTEGER DEFAULT 0').run() // apariciones en arena; si la columna es nueva, arranca con arenas + raids jugadas
        .then(() => db.prepare('UPDATE g_species SET apps = arenas + raids').run()).catch(() => {}))
      .then(() => db.prepare('ALTER TABLE g_saves ADD COLUMN pc TEXT').run().catch(() => {})) // contenido de la Caja de cada partida
      .then(() => db.prepare('ALTER TABLE room_members ADD COLUMN avatar TEXT').run().catch(() => {})) // salas creadas antes de existir el avatar: añade la columna (si ya existe, falla sin problema)
      .catch(e => { ready = null; throw e; }));
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

// ---- Arena multijugador ----
const ROOM_MAX = 30, ROOM_PLAYERS = 3, ROOM_TTL = 864e5, CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = v => (typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) : '') || 'Jugador';
const cleanAvatar = v => (typeof v === 'string' && /^[a-z0-9_-]{1,20}$/i.test(v)) ? v : '';
const cleanCode = v => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) : '');
async function roomState(db, code, acc) {
    const room = await db.prepare('SELECT code, host, status, result FROM rooms WHERE code = ?1').bind(code).first();
    if (!room) return null;
    const [mem, pk] = await db.batch([
        db.prepare('SELECT acc, name, avatar FROM room_members WHERE code = ?1 ORDER BY ts').bind(code),
        db.prepare('SELECT acc, n, data FROM room_picks WHERE code = ?1 ORDER BY acc, n').bind(code),
    ]);
    const picks = {}; for (const r of pk.results) (picks[r.acc] = picks[r.acc] || []).push(r.data);
    return '{"code":"' + room.code + '","status":"' + room.status + '","host":"' + room.host + '","me":"' + acc + '","result":' + (room.result || 'null') +
        ',"members":' + JSON.stringify(mem.results.map(m => ({ acc: m.acc, name: m.name, avatar: m.avatar || '' }))) +
        ',"picks":{' + Object.keys(picks).map(a => '"' + a + '":[' + picks[a].join(',') + ']').join(',') + '}}';
}
async function roomApi(db, h, route, req, url) {
    const acc = h.slice(0, 12), now = Date.now();
    if (Math.random() < 0.05) await db.batch([
        db.prepare('DELETE FROM room_picks WHERE code IN (SELECT code FROM rooms WHERE ts < ?1)').bind(now - ROOM_TTL),
        db.prepare('DELETE FROM room_snap WHERE code IN (SELECT code FROM rooms WHERE ts < ?1)').bind(now - ROOM_TTL),
        db.prepare('DELETE FROM room_members WHERE code IN (SELECT code FROM rooms WHERE ts < ?1)').bind(now - ROOM_TTL),
        db.prepare('DELETE FROM rooms WHERE ts < ?1').bind(now - ROOM_TTL),
    ]);
    if (route === '/api/room/state' && req.method === 'GET') {
        const code = cleanCode(url.searchParams.get('code'));
        const mine = await db.prepare('SELECT 1 FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc).first();
        if (!mine) return reply({ error: 'no estás en esa sala' }, 403);
        const st = await roomState(db, code, acc); return st ? reply(st) : reply({ error: 'la sala no existe' }, 404);
    }
    if (route === '/api/room/snap' && req.method === 'GET') { // los jugadores piden la última instantánea de la arena (solo si es más nueva que 'since')
        const code = cleanCode(url.searchParams.get('code')), since = Math.max(0, +url.searchParams.get('since') || 0);
        const [mine, row] = await db.batch([
            db.prepare('SELECT 1 AS ok FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc),
            db.prepare('SELECT r.status AS status, s.seq AS seq, CASE WHEN s.seq > ?2 THEN s.data END AS data FROM rooms r LEFT JOIN room_snap s ON s.code = r.code WHERE r.code = ?1').bind(code, since),
        ]);
        if (!mine.results.length) return reply({ error: 'no estás en esa sala' }, 403);
        const r = row.results[0]; if (!r) return reply({ error: 'la sala no existe' }, 404);
        return reply('{"status":"' + r.status + '","seq":' + (r.seq || 0) + ',"snap":' + (r.data || 'null') + '}'); // el texto de la instantánea se reenvía tal cual, sin parsearlo
    }
    if (req.method !== 'POST') return reply({ error: 'no existe' }, 404);
    const t = await req.text(); if (t.length > 2e6) return reply({ error: 'demasiado grande' }, 413);
    let b; try { b = JSON.parse(t || '{}'); } catch (e) { return reply({ error: 'json no válido' }, 400); }
    if (!isObj(b)) return reply({ error: 'petición no válida' }, 400);
    if (route === '/api/room/create') {
        let code = '';
        for (let tries = 0; tries < 8; tries++) {
            code = Array.from(crypto.getRandomValues(new Uint8Array(5)), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
            if (!(await db.prepare('SELECT 1 FROM rooms WHERE code = ?1').bind(code).first())) break; code = '';
        }
        if (!code) return reply({ error: 'inténtalo de nuevo' }, 500);
        await db.batch([
            db.prepare('INSERT INTO rooms (code, host, status, ts) VALUES (?1, ?2, ?3, ?4)').bind(code, acc, 'lobby', now),
            db.prepare('INSERT INTO room_members (code, acc, name, ts, avatar) VALUES (?1, ?2, ?3, ?4, ?5)').bind(code, acc, cleanName(b.name), now, cleanAvatar(b.avatar)),
        ]);
        return reply({ code });
    }
    const code = cleanCode(b.code);
    const room = await db.prepare('SELECT host, status FROM rooms WHERE code = ?1').bind(code).first();
    if (!room) return reply({ error: 'la sala no existe' }, 404);
    if (route === '/api/room/join') {
        const mine = await db.prepare('SELECT 1 FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc).first();
        if (mine) await db.prepare('UPDATE room_members SET name = ?1, avatar = ?2 WHERE code = ?3 AND acc = ?4').bind(cleanName(b.name), cleanAvatar(b.avatar), code, acc).run(); // el perfil pudo cambiar
        if (!mine) {
            if (room.status !== 'lobby') return reply({ error: 'la sala ya empezó' }, 409);
            const n = await db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE code = ?1').bind(code).first();
            if (n.n >= ROOM_PLAYERS) return reply({ error: 'sala llena (máximo ' + ROOM_PLAYERS + ' jugadores)' }, 409);
            await db.prepare('INSERT OR IGNORE INTO room_members (code, acc, name, ts, avatar) VALUES (?1, ?2, ?3, ?4, ?5)').bind(code, acc, cleanName(b.name), now, cleanAvatar(b.avatar)).run();
        }
        return reply({ ok: true, code });
    }
    const member = await db.prepare('SELECT 1 FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc).first();
    if (!member) return reply({ error: 'no estás en esa sala' }, 403);
    if (route === '/api/room/picks') {
        if (room.status !== 'lobby') return reply({ error: 'la sala ya empezó' }, 409);
        const list = Array.isArray(b.picks) ? b.picks.slice(0, ROOM_MAX) : [];
        const others = await db.prepare('SELECT COUNT(*) AS n FROM room_picks WHERE code = ?1 AND acc != ?2').bind(code, acc).first();
        if (others.n + list.length > ROOM_MAX) return reply({ error: 'no caben más: quedan ' + Math.max(0, ROOM_MAX - others.n) + ' huecos' }, 409);
        const st = [db.prepare('DELETE FROM room_picks WHERE code = ?1 AND acc = ?2').bind(code, acc)];
        let i = 0;
        for (const p of list) {
            if (!isObj(p) || typeof p.id !== 'string' || p.id.length > 40) continue;
            const d = JSON.stringify(p); if (d.length > 4000) continue;
            st.push(db.prepare('INSERT INTO room_picks (code, acc, n, data) VALUES (?1, ?2, ?3, ?4)').bind(code, acc, i++, d));
        }
        st.push(db.prepare('UPDATE rooms SET ts = ?1 WHERE code = ?2').bind(now, code));
        await db.batch(st); return reply({ ok: true });
    }
    if (route === '/api/room/leave') {
        const st = [db.prepare('DELETE FROM room_picks WHERE code = ?1 AND acc = ?2').bind(code, acc), db.prepare('DELETE FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc)];
        if (room.host === acc) st.push(db.prepare("UPDATE rooms SET status = 'closed', ts = ?1 WHERE code = ?2").bind(now, code)); // si se va el anfitrión, la sala se cierra
        await db.batch(st); return reply({ ok: true });
    }
    if (room.host !== acc) return reply({ error: 'solo el anfitrión puede hacerlo' }, 403);
    if (route === '/api/room/start') {
        if (room.status !== 'lobby') return reply({ error: 'la sala ya empezó' }, 409);
        const { results } = await db.prepare('SELECT m.acc AS acc, (SELECT COUNT(*) FROM room_picks p WHERE p.code = m.code AND p.acc = m.acc) AS n FROM room_members m WHERE m.code = ?1').bind(code).all();
        if (results.some(r => r.n < 1)) return reply({ error: 'todos los jugadores deben añadir al menos 1 pokémon' }, 409);
        await db.batch([
            db.prepare("UPDATE rooms SET status = 'playing', ts = ?1 WHERE code = ?2").bind(now, code),
            db.prepare('DELETE FROM room_snap WHERE code = ?1').bind(code), // sin restos de la ronda anterior
        ]);
        return reply({ ok: true });
    }
    if (route === '/api/room/snap') { // el anfitrión publica el estado de la arena que está simulando
        if (room.status !== 'playing') return reply({ ok: true, stale: true });
        const d = JSON.stringify(isObj(b.snap) ? b.snap : {}); if (d.length > 250000) return reply({ error: 'instantánea demasiado grande' }, 413);
        await db.prepare('INSERT INTO room_snap (code, seq, data) VALUES (?1, 1, ?2) ON CONFLICT(code) DO UPDATE SET seq = seq + 1, data = excluded.data').bind(code, d).run();
        return reply({ ok: true });
    }
    if (route === '/api/room/reset') { // otra ronda: vuelve al lobby con los mismos jugadores y pokémon
        await db.batch([
            db.prepare("UPDATE rooms SET status = 'lobby', result = NULL, ts = ?1 WHERE code = ?2").bind(now, code),
            db.prepare('DELETE FROM room_snap WHERE code = ?1').bind(code),
        ]);
        return reply({ ok: true });
    }
    if (route === '/api/room/result') {
        const r = JSON.stringify(isObj(b.result) ? b.result : {}); if (r.length > 100000) return reply({ error: 'resultado demasiado grande' }, 413);
        await db.prepare("UPDATE rooms SET status = 'done', result = ?1, ts = ?2 WHERE code = ?3").bind(r, now, code).run();
        return reply({ ok: true });
    }
    return reply({ error: 'no existe' }, 404);
}

const NUM = ['gen', 'genManual', 'apps', 'arenas', 'wins', 'kos', 'faints', 'elims', 'caps', 'ms', 'dealt', 'taken', 'raids', 'raidWins', 'bosses'];
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
        for (const e of b.saves.slice(0, 10)) if (isObj(e) && typeof e.id === 'string') {
            const { pc, ...rest } = e, pcs = isObj(pc) ? JSON.stringify(pc) : null, id = acc + ':' + e.id.slice(0, 24);
            if (pcs && pcs.length > 400000) continue;
            // la Caja va aparte (la lista de partidas no la trae); si no se eliminó a mano, se guarda o actualiza
            st.push(db.prepare('INSERT OR REPLACE INTO g_saves (id, acc, updated, body, pc) SELECT ?1, ?2, ?3, ?4, COALESCE(?5, (SELECT pc FROM g_saves WHERE id = ?1)) WHERE NOT EXISTS (SELECT 1 FROM g_saves_del WHERE id = ?1)').bind(id, acc, now, JSON.stringify(rest), pcs));
        }
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
            if (route.startsWith('/api/room/')) return await roomApi(db, h, route, req, url);
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
            if (route === '/api/g/save' && req.method === 'GET') { // la Caja de una partida del registro
                const row = await db.prepare('SELECT pc FROM g_saves WHERE id = ?1').bind(url.searchParams.get('k') || '').first();
                return reply('{"pc":' + ((row && row.pc) || 'null') + '}');
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
                else if (b.what === 'saves') await db.prepare('DELETE FROM g_saves').run();
                else if (b.what === 'save') { // elimina UNA fila del registro de partidas y deja constancia para que no se vuelva a crear
                    const id = String(b.acc || '').slice(0, 8) + ':' + String(b.id || '').slice(0, 24);
                    if (id.length < 3) return reply({ error: 'falta la partida' }, 400);
                    await db.batch([db.prepare('DELETE FROM g_saves WHERE id = ?1').bind(id), db.prepare('INSERT OR IGNORE INTO g_saves_del (id) VALUES (?1)').bind(id)]);
                }
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
