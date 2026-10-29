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
        db.prepare('CREATE TABLE IF NOT EXISTS g_saves (id TEXT PRIMARY KEY, acc TEXT NOT NULL, updated INTEGER NOT NULL, body TEXT NOT NULL, pc TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS g_saves_del (id TEXT PRIMARY KEY)'), // filas del registro de partidas eliminadas a mano: no se vuelven a crear
        db.prepare('CREATE TABLE IF NOT EXISTS g_seen (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL)'),
        // ---- arena multijugador: salas, miembros y pokémon aportados ----
        db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, host TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, result TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS room_members (code TEXT NOT NULL, acc TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, avatar TEXT, PRIMARY KEY (code, acc))'),
        db.prepare('CREATE TABLE IF NOT EXISTS room_picks (code TEXT NOT NULL, acc TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (code, acc, n))'),
        // última instantánea de la arena que publica el anfitrión (la simula él; el resto de jugadores la ve en directo)
        db.prepare('CREATE TABLE IF NOT EXISTS room_snap (code TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)'),
        // ---- PVP 1 contra 1: cola de emparejamiento (un ticket por jugador buscando) y órdenes del invitado hacia el anfitrión ----
        db.prepare('CREATE TABLE IF NOT EXISTS pvp_queue (acc TEXT PRIMARY KEY, ts INTEGER NOT NULL, name TEXT, avatar TEXT, team TEXT NOT NULL, code TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS pvp_cmd (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, acc TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS pvp_cmd_code ON pvp_cmd (code, id)'),
        // ---- regalos enviados desde la consola de desarrollador (Pokémon / objetos) a una cuenta ('acc' = 8 primeros caracteres) o a todas ('*') ----
        db.prepare('CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, acc TEXT NOT NULL, ts INTEGER NOT NULL, body TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS gifts_acc ON gifts (acc, ts)'),
        db.prepare('CREATE TABLE IF NOT EXISTS gift_claims (gid TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (gid, h))'),
        // amigos: perfil público de cada cuenta (nombre, avatar, nivel, Salón de la Fama y última conexión) y relaciones (st 0 = solicitud de a hacia b, 1 = amigos)
        db.prepare('CREATE TABLE IF NOT EXISTS profiles (acc TEXT PRIMARY KEY, ts INTEGER NOT NULL, name TEXT, avatar TEXT, lvl INTEGER, hof TEXT, medals TEXT)'),
        db.prepare('CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, st INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (a, b))'),
        db.prepare('CREATE INDEX IF NOT EXISTS friends_b ON friends (b, st)'),
        // chat entre amigos: registro permanente (a < b identifica la pareja; frm = quién escribe, too = quién recibe) y último mensaje leído por cada cuenta en cada conversación
        db.prepare('CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, pair TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, frm TEXT NOT NULL, too TEXT NOT NULL, ts INTEGER NOT NULL, txt TEXT NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS chat_pair ON chat (pair, id)'),
        db.prepare('CREATE INDEX IF NOT EXISTS chat_too ON chat (too, id)'),
        db.prepare('CREATE TABLE IF NOT EXISTS chat_read (acc TEXT NOT NULL, peer TEXT NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (acc, peer))'),
    ]).then(() => db.prepare('DROP TABLE IF EXISTS g_species').run()) // el registro por especie ya no existe
      .then(() => db.prepare('CREATE TABLE IF NOT EXISTS save_codes (code TEXT PRIMARY KEY, h TEXT NOT NULL, slot INTEGER NOT NULL, ts INTEGER NOT NULL)').run()) // código único de cada partida -> cuenta y ranura que la guardan
      .then(() => db.prepare('CREATE TABLE IF NOT EXISTS mis_score (mid TEXT NOT NULL, acc TEXT NOT NULL, n INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT, avatar TEXT, PRIMARY KEY (mid, acc))').run())
      .then(() => db.prepare('CREATE TABLE IF NOT EXISTS mis_claim (mid TEXT NOT NULL, acc TEXT NOT NULL, pick TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (mid, acc))').run())
      .then(() => db.prepare('ALTER TABLE g_saves ADD COLUMN pc TEXT').run().catch(() => {})) // contenido de la Caja de cada partida
      .then(() => db.prepare('ALTER TABLE profiles ADD COLUMN medals TEXT').run().catch(() => {})) // medallas de la Liga (ids) que ven los amigos en la ficha de perfil
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
// ---- PVP 1 contra 1 ----
// find: el jugador deja (o refresca) su ticket con sus 6 pokémon y pregunta si ya tiene rival. Quien encuentra primero a otro ticket libre crea
// la sala (estado 'playing', ambos miembros con sus picks) y será el ANFITRIÓN (simula el combate); el otro se entera en su siguiente consulta.
const PVP_WAIT = 15000;
async function pvpApi(db, h, route, req, url) {
    const acc = h.slice(0, 12), now = Date.now();
    if (Math.random() < 0.1) await db.batch([
        db.prepare('DELETE FROM pvp_queue WHERE ts < ?1').bind(now - 60000),
        db.prepare('DELETE FROM pvp_cmd WHERE ts < ?1').bind(now - ROOM_TTL),
    ]);
    if (route === '/api/pvp/cmds' && req.method === 'GET') {
        const code = cleanCode(url.searchParams.get('code')), since = Math.max(0, +url.searchParams.get('since') || 0);
        const mine = await db.prepare('SELECT 1 FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc).first();
        if (!mine) return reply({ error: 'no estás en esa sala' }, 403);
        const wait = Math.min(6, Math.max(0, +url.searchParams.get('wait') || 0)), endAt = Date.now() + wait * 1000; // sondeo largo: responde en cuanto llega una orden (máx. 6 s)
        let results;
        for (;;) {
            ({ results } = await db.prepare('SELECT id, data FROM pvp_cmd WHERE code = ?1 AND id > ?2 AND acc != ?3 ORDER BY id LIMIT 40').bind(code, since, acc).all());
            if (results.length || Date.now() >= endAt) break;
            await new Promise(r => setTimeout(r, 250));
        }
        return reply('{"cmds":[' + results.map(r => '{"id":' + r.id + ',"c":' + r.data + '}').join(',') + ']}');
    }
    if (req.method !== 'POST') return reply({ error: 'no existe' }, 404);
    const t = await req.text(); if (t.length > 3e5) return reply({ error: 'demasiado grande' }, 413);
    let b; try { b = JSON.parse(t || '{}'); } catch (e) { return reply({ error: 'json no válido' }, 400); }
    if (!isObj(b)) return reply({ error: 'petición no válida' }, 400);
    if (route === '/api/pvp/cancel') { await db.prepare('DELETE FROM pvp_queue WHERE acc = ?1 AND code IS NULL').bind(acc).run(); return reply({ ok: true }); }
    if (route === '/api/pvp/cmd') {
        const code = cleanCode(b.code);
        const room = await db.prepare('SELECT status FROM rooms WHERE code = ?1').bind(code).first();
        const mine = await db.prepare('SELECT 1 FROM room_members WHERE code = ?1 AND acc = ?2').bind(code, acc).first();
        if (!room || !mine) return reply({ error: 'no estás en esa sala' }, 403);
        if (room.status !== 'playing') return reply({ ok: true, stale: true });
        const d = JSON.stringify(isObj(b.c) ? b.c : {}); if (d.length > 600) return reply({ error: 'orden demasiado grande' }, 413);
        await db.prepare('INSERT INTO pvp_cmd (code, acc, ts, data) VALUES (?1, ?2, ?3, ?4)').bind(code, acc, now, d).run();
        return reply({ ok: true });
    }
    if (route === '/api/pvp/find') {
        const mine = await db.prepare('SELECT code FROM pvp_queue WHERE acc = ?1').bind(acc).first();
        if (mine && mine.code && !b.fresh) { // otro jugador ya te emparejó: tú eres el invitado
            await db.prepare('DELETE FROM pvp_queue WHERE acc = ?1').bind(acc).run();
            return reply({ matched: true, code: mine.code, host: false });
        }
        const list = (Array.isArray(b.team) ? b.team : []).slice(0, 6).filter(p => isObj(p) && typeof p.id === 'string' && p.id.length <= 40 && JSON.stringify(p).length <= 4000);
        if (!list.length) return reply({ error: 'tu Salón de la Fama está vacío' }, 400);
        if (b.fresh) await db.prepare('DELETE FROM pvp_queue WHERE acc = ?1').bind(acc).run(); // primera consulta de una búsqueda nueva: sin restos de otras
        await db.prepare('INSERT INTO pvp_queue (acc, ts, name, avatar, team, code) VALUES (?1, ?2, ?3, ?4, ?5, NULL) ON CONFLICT(acc) DO UPDATE SET ts = excluded.ts, name = excluded.name, avatar = excluded.avatar, team = excluded.team')
            .bind(acc, now, cleanName(b.name), cleanAvatar(b.avatar), JSON.stringify(list)).run();
        const again = await db.prepare('SELECT code FROM pvp_queue WHERE acc = ?1').bind(acc).first();
        if (again && again.code) { await db.prepare('DELETE FROM pvp_queue WHERE acc = ?1').bind(acc).run(); return reply({ matched: true, code: again.code, host: false }); }
        const other = await db.prepare('SELECT acc, name, avatar, team FROM pvp_queue WHERE acc > ?1 AND code IS NULL AND ts > ?2 ORDER BY ts LIMIT 1').bind(acc, now - PVP_WAIT).first(); // solo el de ID menor empareja: así dos jugadores nunca crean dos salas a la vez
        if (!other) return reply({ matched: false });
        let code = '';
        for (let tries = 0; tries < 8; tries++) {
            code = Array.from(crypto.getRandomValues(new Uint8Array(5)), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
            if (!(await db.prepare('SELECT 1 FROM rooms WHERE code = ?1').bind(code).first())) break; code = '';
        }
        if (!code) return reply({ error: 'no se pudo crear la partida' }, 500);
        const claimMe = await db.prepare('UPDATE pvp_queue SET code = ?1 WHERE acc = ?2 AND code IS NULL').bind(code, acc).run(); // primero me reservo yo (por si otro me empareja a la vez)
        if (!claimMe.meta || claimMe.meta.changes !== 1) return reply({ matched: false });
        const claim = await db.prepare('UPDATE pvp_queue SET code = ?1 WHERE acc = ?2 AND code IS NULL').bind(code, other.acc).run();
        if (!claim.meta || claim.meta.changes !== 1) { await db.prepare('UPDATE pvp_queue SET code = NULL WHERE acc = ?1 AND code = ?2').bind(acc, code).run(); return reply({ matched: false }); } // otro jugador se le adelantó
        const st = [
            db.prepare('INSERT INTO rooms (code, host, status, ts) VALUES (?1, ?2, ?3, ?4)').bind(code, acc, 'playing', now),
            db.prepare('INSERT INTO room_members (code, acc, name, ts, avatar) VALUES (?1, ?2, ?3, ?4, ?5)').bind(code, acc, cleanName(b.name), now, cleanAvatar(b.avatar)),
            db.prepare('INSERT INTO room_members (code, acc, name, ts, avatar) VALUES (?1, ?2, ?3, ?4, ?5)').bind(code, other.acc, other.name || 'Jugador', now + 1, other.avatar || ''),
        ];
        list.forEach((p, i) => st.push(db.prepare('INSERT INTO room_picks (code, acc, n, data) VALUES (?1, ?2, ?3, ?4)').bind(code, acc, i, JSON.stringify(p))));
        let ot = []; try { ot = JSON.parse(other.team); } catch (e) {}
        ot.forEach((p, i) => st.push(db.prepare('INSERT INTO room_picks (code, acc, n, data) VALUES (?1, ?2, ?3, ?4)').bind(code, other.acc, i, JSON.stringify(p))));
        st.push(db.prepare('DELETE FROM pvp_queue WHERE acc = ?1').bind(acc));
        await db.batch(st);
        return reply({ matched: true, code, host: true });
    }
    return reply({ error: 'no existe' }, 404);
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
        const wait = Math.min(6, Math.max(0, +url.searchParams.get('wait') || 0)), endAt = Date.now() + wait * 1000; // sondeo largo (PVP): espera a una instantánea más nueva (máx. 6 s)
        if (wait > 0) for (;;) {
            const q = await db.prepare('SELECT r.status AS status, s.seq AS seq FROM rooms r LEFT JOIN room_snap s ON s.code = r.code WHERE r.code = ?1').bind(code).first();
            if (!q || q.status !== 'playing' || (q.seq || 0) > since || Date.now() >= endAt) break;
            await new Promise(r => setTimeout(r, 250));
        }
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

const num = v => (Number.isFinite(v) ? Math.max(0, Math.min(1e12, Math.round(v))) : 0);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Un registro global: { rid, arena?, saves? }. Es idempotente por 'rid' (el cliente puede reintentar).
// ---- amigos ----
const SPR_OK = /^https:\/\/raw\.githubusercontent\.com\/PokeAPI\/sprites\/[A-Za-z0-9\/_.\-]{1,170}$/;
const cleanMedals = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x || '')).filter(x => /^[a-z]{1,12}$/.test(x)))].slice(0, 16);
const parseMedals = t => { try { return cleanMedals(JSON.parse(t || '[]')); } catch (e) { return []; } };
const cleanHof = a => (Array.isArray(a) ? a : []).slice(0, 6).map(m => (m && typeof m === 'object' && typeof m.s === 'string' && SPR_OK.test(m.s))
    ? { n: String(m.n || '').replace(/[<>"&]/g, '').slice(0, 30), s: m.s, sh: m.sh ? 1 : 0 } : null);
const MIS2_END = Date.parse('2026-10-26T18:00:00Z'); // Misión 2 (La Granjera): lunes 26 de octubre, 12:00 del mediodía en Costa Rica
const miltankScore = (iv, hf, wf) => { const sum = iv.reduce((a, v) => a + v, 0); return Math.max(1, Math.min(100, Math.round(1 + 99 * (0.6 * sum / 186 + 0.2 * hf / 1000 + 0.2 * wf / 1000)))); };
const MIS_END = Date.parse('2026-10-29T05:59:00Z'); // miércoles 28 de octubre, 11:59 pm en Costa Rica (UTC-6)
async function friendsApi(db, h, route, req, url) {
    const me = h.slice(0, 8), now = Date.now(), q = (sql, ...a) => db.prepare(sql).bind(...a);
    const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const other = v => { const x = String((b && v) || '').toLowerCase(); return /^[a-f0-9]{8}$/.test(x) ? x : null; };
    if (route === '/api/f/ping' && req.method === 'POST') {
        const name = String(b.name || '').replace(/[<>"&]/g, '').trim().slice(0, 24);
        const avatar = /^[a-z0-9_-]{1,12}$/i.test(b.avatar || '') ? b.avatar : '';
        const lvl = Math.max(1, Math.min(999, b.lvl | 0 || 1));
        await q('INSERT INTO profiles (acc, ts, name, avatar, lvl, hof, medals) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(acc) DO UPDATE SET ts = ?2, name = ?3, avatar = ?4, lvl = ?5, hof = ?6, medals = ?7',
            me, now, name, avatar, lvl, JSON.stringify(cleanHof(b.hof)), JSON.stringify(cleanMedals(b.medals))).run();
        return reply({ ok: true, acc: me, now });
    }
    if (route === '/api/f/mission' && req.method === 'POST') { // Misión 1: capturas de Johto (solo sube; se cierra el domingo 24-oct 12:00 hora de Costa Rica)
        if (b.mid !== 'm1' && b.mid !== 'm2') return reply({ error: 'misión no válida' }, 400);
        if (now > (b.mid === 'm2' ? MIS2_END : MIS_END) + 30000) return reply({ closed: true, now });
        let n = Math.max(0, Math.min(999, b.n | 0));
        if (b.mid === 'm2') { // La Granjera: la nota (1-100) se calcula AQUÍ con IVs, tamaño y peso del Miltank enviado
            const iv = Array.isArray(b.iv) && b.iv.length === 6 ? b.iv.map(v => Math.max(0, Math.min(31, v | 0))) : null;
            const hf = Math.max(0, Math.min(1000, b.hf | 0)), wf = Math.max(0, Math.min(1000, b.wf | 0));
            if (!iv) return reply({ error: 'ejemplar no válido' }, 400);
            n = miltankScore(iv, hf, wf);
        }
        const name = String(b.name || '').replace(/[<>"&]/g, '').trim().slice(0, 24) || 'Entrenador';
        const avatar = /^[a-z0-9_-]{1,12}$/i.test(b.avatar || '') ? b.avatar : '';
        await q('INSERT INTO mis_score (mid, acc, n, ts, name, avatar) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(mid, acc) DO UPDATE SET n = ?3, ts = ?4, name = ?5, avatar = ?6 WHERE ?3 > mis_score.n',
            b.mid, me, n, now, name, avatar).run();
        const best = await q('SELECT n FROM mis_score WHERE mid = ?1 AND acc = ?2', b.mid, me).first();
        return reply({ ok: true, now, score: n, best: best ? best.n : n });
    }
    if (route === '/api/f/mclaim' && req.method === 'POST') { // solo el GANADOR (más capturas; empate: quien llegó antes) elige 1 recompensa, una sola vez
        if (b.mid === 'm2') { // La Granjera: el MEJOR Miltank (nota más alta; empate: quien llegó antes) cobra 25 000 ₽, 10 Ultra Ball y 2 Tiquetes de Raid, una sola vez
            if (now <= MIS2_END + 30000) return reply({ error: 'la misión aún no termina' }, 403);
            const top2 = await q('SELECT acc FROM mis_score WHERE mid = ?1 AND n > 0 ORDER BY n DESC, ts ASC LIMIT 1', 'm2').first();
            if (!top2 || top2.acc !== me) return reply({ error: 'no eres el ganador' }, 403);
            const ex2 = await q('SELECT pick FROM mis_claim WHERE mid = ?1 AND acc = ?2', 'm2', me).first();
            if (ex2) return reply({ ok: true, pick: ex2.pick, already: true });
            await q('INSERT INTO mis_claim (mid, acc, pick, ts) VALUES (?1, ?2, ?3, ?4)', 'm2', me, 'reward', now).run();
            return reply({ ok: true, pick: 'reward' });
        }
        if (now <= MIS_END + 30000) return reply({ error: 'la misión aún no termina' }, 403);
        if (!['chikorita', 'cyndaquil', 'totodile'].includes(b.pick)) return reply({ error: 'elección no válida' }, 400);
        const top = await q('SELECT acc FROM mis_score WHERE mid = ?1 AND n > 0 ORDER BY n DESC, ts ASC LIMIT 1', 'm1').first();
        if (!top || top.acc !== me) return reply({ error: 'no eres el ganador' }, 403);
        const ex = await q('SELECT pick FROM mis_claim WHERE mid = ?1 AND acc = ?2', 'm1', me).first();
        if (ex) return reply({ ok: true, pick: ex.pick, already: true });
        await q('INSERT INTO mis_claim (mid, acc, pick, ts) VALUES (?1, ?2, ?3, ?4)', 'm1', me, b.pick, now).run();
        return reply({ ok: true, pick: b.pick });
    }
    if (route === '/api/f/mboard' && req.method === 'GET') {
        const mid = url.searchParams.get('mid') === 'm2' ? 'm2' : 'm1';
        const { results } = await q('SELECT acc, n, ts, name, avatar FROM mis_score WHERE mid = ?1 AND n > 0 ORDER BY n DESC, ts ASC LIMIT 50', mid).all();
        const cl = await q('SELECT pick FROM mis_claim WHERE mid = ?1 AND acc = ?2', mid, me).first();
        return reply({ now, end: mid === 'm2' ? MIS2_END : MIS_END, me, board: results, claim: cl ? cl.pick : null });
    }
    if (route === '/api/f/list' && req.method === 'GET') {
        const [fr, inc, out, unr] = await db.batch([
            q('SELECT CASE WHEN f.a = ?1 THEN f.b ELSE f.a END AS acc, p.name, p.avatar, p.lvl, p.ts FROM friends f LEFT JOIN profiles p ON p.acc = (CASE WHEN f.a = ?1 THEN f.b ELSE f.a END) WHERE f.st = 1 AND (f.a = ?1 OR f.b = ?1) LIMIT 150', me),
            q('SELECT f.a AS acc, p.name, p.avatar, p.lvl, p.hof, p.medals, p.ts FROM friends f LEFT JOIN profiles p ON p.acc = f.a WHERE f.st = 0 AND f.b = ?1 ORDER BY f.ts DESC LIMIT 30', me),
            q('SELECT f.b AS acc, p.name, p.avatar FROM friends f LEFT JOIN profiles p ON p.acc = f.b WHERE f.st = 0 AND f.a = ?1 ORDER BY f.ts DESC LIMIT 30', me),
            q('SELECT c.frm AS acc, COUNT(*) AS n FROM chat c WHERE c.too = ?1 AND c.id > COALESCE((SELECT r.last FROM chat_read r WHERE r.acc = ?1 AND r.peer = c.frm), 0) GROUP BY c.frm', me),
        ]);
        const unread = {}; for (const r of unr.results) unread[r.acc] = r.n;
        const hof = t => { try { return JSON.parse(t || '[]'); } catch (e) { return []; } };
        return reply({ now, me, friends: fr.results, unread, incoming: inc.results.map(r => ({ ...r, hof: hof(r.hof), medals: parseMedals(r.medals) })), outgoing: out.results });
    }
    if (route === '/api/f/profile' && req.method === 'GET') { // ficha completa de un AMIGO (solo si sois amigos)
        const who = String(url.searchParams.get('acc') || '').toLowerCase();
        if (!/^[a-f0-9]{8}$/.test(who)) return reply({ error: 'ID no válido' }, 400);
        if (!(await q('SELECT 1 FROM friends WHERE st = 1 AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))', me, who).first())) return reply({ error: 'No sois amigos' }, 403);
        const p = await q('SELECT acc, name, avatar, lvl, hof, medals, ts FROM profiles WHERE acc = ?1', who).first();
        let hof = []; try { hof = JSON.parse((p && p.hof) || '[]'); } catch (e) {}
        return reply({ now, acc: who, name: (p && p.name) || '', avatar: (p && p.avatar) || '', lvl: (p && p.lvl) || 1, ts: (p && p.ts) || 0, hof, medals: parseMedals(p && p.medals) });
    }
    if (route === '/api/f/request' && req.method === 'POST') {
        const to = other(b.to);
        if (!to) return reply({ error: 'ID no válido (son 8 caracteres)' }, 400);
        if (to === me) return reply({ error: 'Ese es tu propio ID' }, 400);
        if (!(await q('SELECT 1 FROM accounts WHERE substr(h, 1, 8) = ?1', to).first())) return reply({ error: 'No existe ninguna cuenta con ese ID' }, 404);
        const ex = await q('SELECT a, st FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)', me, to).first();
        if (ex) {
            if (ex.st === 1) return reply({ ok: true, state: 'friends' });
            if (ex.a === me) return reply({ ok: true, state: 'sent' });
            await q('UPDATE friends SET st = 1, ts = ?3 WHERE a = ?1 AND b = ?2', to, me, now).run(); // ya te había enviado una solicitud: se aceptan mutuamente
            return reply({ ok: true, state: 'friends' });
        }
        const cnt = await q('SELECT COUNT(*) AS n FROM friends WHERE a = ?1 OR b = ?1', me).first();
        if (cnt && cnt.n >= 150) return reply({ error: 'Has alcanzado el límite de amigos y solicitudes' }, 400);
        await q('INSERT INTO friends (a, b, st, ts) VALUES (?1, ?2, 0, ?3)', me, to, now).run();
        return reply({ ok: true, state: 'sent' });
    }
    if (route === '/api/f/respond' && req.method === 'POST') {
        const from = other(b.from); if (!from) return reply({ error: 'ID no válido' }, 400);
        if (b.accept) await q('UPDATE friends SET st = 1, ts = ?3 WHERE a = ?1 AND b = ?2 AND st = 0', from, me, now).run();
        else await q('DELETE FROM friends WHERE a = ?1 AND b = ?2 AND st = 0', from, me).run();
        return reply({ ok: true });
    }
    const areFriends = who => q('SELECT 1 FROM friends WHERE st = 1 AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))', me, who).first();
    const pairOf = who => (me < who ? me + ':' + who : who + ':' + me);
    if (route === '/api/f/chat/send' && req.method === 'POST') {
        const to = other(b.to); if (!to) return reply({ error: 'ID no válido' }, 400);
        const txt = String(b.txt || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 300);
        if (!txt) return reply({ error: 'mensaje vacío' }, 400);
        if (!(await areFriends(to))) return reply({ error: 'Solo puedes escribir a tus amigos' }, 403);
        const rc = await q('SELECT COUNT(*) AS n FROM chat WHERE frm = ?1 AND ts > ?2', me, now - 60000).first();
        if (rc && rc.n >= 25) return reply({ error: 'Vas demasiado rápido, espera un momento' }, 429);
        const a = me < to ? me : to, bb = me < to ? to : me;
        const r = await q('INSERT INTO chat (pair, a, b, frm, too, ts, txt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)', pairOf(to), a, bb, me, to, now, txt).run();
        const id = r && r.meta ? r.meta.last_row_id : 0;
        await q('INSERT INTO chat_read (acc, peer, last) VALUES (?1, ?2, ?3) ON CONFLICT(acc, peer) DO UPDATE SET last = MAX(last, ?3)', me, to, id).run(); // lo que escribes tú cuenta como leído
        return reply({ ok: true, id, ts: now });
    }
    if (route === '/api/f/chat' && req.method === 'GET') { // historial de una conversación (solo con amigos); after = último id que ya tienes
        const who = String(url.searchParams.get('acc') || '').toLowerCase();
        if (!/^[a-f0-9]{8}$/.test(who)) return reply({ error: 'ID no válido' }, 400);
        const after = Math.max(0, +url.searchParams.get('after') || 0), before = Math.max(0, +url.searchParams.get('before') || 0);
        const { results } = before
            ? await q('SELECT id, frm, ts, txt FROM chat WHERE pair = ?1 AND id < ?2 ORDER BY id DESC LIMIT 60', pairOf(who), before).all()
            : after ? await q('SELECT id, frm, ts, txt FROM chat WHERE pair = ?1 AND id > ?2 ORDER BY id LIMIT 100', pairOf(who), after).all()
            : await q('SELECT id, frm, ts, txt FROM (SELECT id, frm, ts, txt FROM chat WHERE pair = ?1 ORDER BY id DESC LIMIT 60) ORDER BY id', pairOf(who)).all();
        const msgs = before ? results.reverse() : results;
        const top = msgs.reduce((m, r) => Math.max(m, r.id), 0);
        if (top && !before && url.searchParams.get('read') === '1') await q('INSERT INTO chat_read (acc, peer, last) VALUES (?1, ?2, ?3) ON CONFLICT(acc, peer) DO UPDATE SET last = MAX(last, ?3)', me, who, top).run();
        return reply({ now, me, msgs, more: !after && msgs.length >= 60 });
    }
    if (route === '/api/f/inbox' && req.method === 'GET') { // mensajes nuevos para mí (sondeo ligero); after < 0 solo devuelve el id actual
        const after = +url.searchParams.get('after');
        if (!(after >= 0)) { const m = await q('SELECT COALESCE(MAX(id), 0) AS m FROM chat WHERE too = ?1', me).first(); return reply({ now, max: (m && m.m) || 0, msgs: [] }); }
        const { results } = await q('SELECT c.id, c.frm, c.ts, c.txt, p.name, p.avatar FROM chat c LEFT JOIN profiles p ON p.acc = c.frm WHERE c.too = ?1 AND c.id > ?2 ORDER BY c.id LIMIT 30', me, after).all();
        return reply({ now, max: results.reduce((m, r) => Math.max(m, r.id), after), msgs: results });
    }
    if (route === '/api/f/remove' && req.method === 'POST') { // elimina un amigo o cancela una solicitud enviada
        const who = other(b.acc); if (!who) return reply({ error: 'ID no válido' }, 400);
        await q('DELETE FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)', me, who).run();
        return reply({ ok: true });
    }
    return reply({ error: 'no existe' }, 404);
}

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

// ---- Tiempo real del PVP (opcional): una sala de Durable Object por partida que reenvía cada mensaje al OTRO jugador ----
// Sin el binding PVP el juego sigue funcionando igual por HTTP (más lento).
export class PvpRoom {
    constructor(state) { this.state = state; }
    async fetch(req) {
        if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('websocket', { status: 426 });
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        this.state.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
    }
    webSocketMessage(ws, msg) {
        if (typeof msg !== 'string' || msg.length > 600000) return;
        for (const o of this.state.getWebSockets()) if (o !== ws) { try { o.send(msg); } catch (e) {} }
    }
    webSocketClose(ws, code) { try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000); } catch (e) {} }
    webSocketError() {}
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const route = url.pathname.replace(/\/+$/, '');
        if (route === '/api/health') return reply({ ok: true, app: 'PokeArena' });
        try {
            const db = env.DB; await init(db);
            if (route === '/api/pvp/ws') { // WebSocket del PVP: se autentica con ?k=<token> (el navegador no puede mandar cabeceras)
                if (!env.PVP) return reply({ error: 'tiempo real no disponible' }, 501);
                if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return reply({ error: 'se esperaba websocket' }, 426);
                const k = url.searchParams.get('k') || '', code = cleanCode(url.searchParams.get('code'));
                if (!/^[a-f0-9]{48}$/.test(k)) return reply({ error: 'cuenta no válida' }, 401);
                const wh = await sha(k), wacc = wh.slice(0, 12);
                if (!(await db.prepare('SELECT 1 FROM accounts WHERE h = ?1').bind(wh).first())) return reply({ error: 'cuenta no válida' }, 401);
                const wr = await db.prepare('SELECT r.status FROM rooms r JOIN room_members m ON m.code = r.code WHERE r.code = ?1 AND m.acc = ?2').bind(code, wacc).first();
                if (!wr || wr.status !== 'playing') return reply({ error: 'no estás en esa partida' }, 403);
                return env.PVP.get(env.PVP.idFromName(code)).fetch(req);
            }
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
            if (route.startsWith('/api/pvp/')) return await pvpApi(db, h, route, req, url);
            if (route.startsWith('/api/f/')) return await friendsApi(db, h, route, req, url);
            // ---- consola de desarrollador GLOBAL ----
            if (route === '/api/g/record' && req.method === 'POST') {
                const t = await req.text(); if (t.length > 3e6) return reply({ error: 'demasiado grande' }, 413);
                let b; try { b = JSON.parse(t); } catch (e) { return reply({ error: 'json no válido' }, 400); }
                const r = await ingest(db, h, b); return reply(r, r.error ? 400 : 200);
            }
            if (route === '/api/g/dev' && req.method === 'GET') {
                const lim = Math.max(1, Math.min(200, +url.searchParams.get('limit') || 100));
                const [ar, sv, ct] = await db.batch([
                    db.prepare('SELECT k, acc, sum FROM g_arenas ORDER BY ts DESC LIMIT ?1').bind(lim),
                    db.prepare('SELECT acc, body FROM g_saves ORDER BY updated DESC LIMIT 500'),
                    db.prepare('SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM g_arenas) AS arenas'),
                ]);
                const arenas = ar.results.map(r => '{"_k":' + JSON.stringify(r.k) + ',"_acc":"' + r.acc + '",' + r.sum.slice(1)).join(',');
                // código para cargar de TODAS las partidas del registro (de cualquier cuenta): primero el que trae el registro; si falta, el de save_codes; si no, se lee de la propia ranura guardada
                const cmap = {}; try { (await db.prepare('SELECT code, h, slot FROM save_codes').all()).results.forEach(c => { cmap[c.h.slice(0, 12) + ':' + c.slot] = c.code; }); } catch (e) {}
                let budget = 30;
                const saves = (await Promise.all(sv.results.map(async r => {
                    let o = null; try { o = JSON.parse(r.body); } catch (e) { return ''; }
                    if (!/^[A-Z0-9]{12}$/.test(o.code || '') && o.status !== 'eliminada' && o.slot) {
                        let c = cmap[r.acc + ':' + o.slot];
                        if (!c && budget > 0) {
                            budget--;
                            try {
                                const hh = await db.prepare('SELECT h FROM blobs WHERE h LIKE ?1 AND k = ?2 LIMIT 1').bind(r.acc + '%', 'slot' + o.slot).first();
                                const txt = hh ? await readKey(db, hh.h, 'slot' + o.slot) : null;
                                const m = txt && /"pokearena\.savecode"\s*:\s*"([A-Z0-9]{12})"/.exec(txt);
                                if (m && (!o.id || txt.includes('"' + o.id + '"'))) { c = m[1]; cmap[r.acc + ':' + o.slot] = c; await db.prepare('INSERT OR IGNORE INTO save_codes (code, h, slot, ts) VALUES (?1, ?2, ?3, ?4)').bind(c, hh.h, +o.slot, Date.now()).run(); }
                            } catch (e) {}
                        }
                        if (c) o.code = c;
                    }
                    return '{"_acc":"' + r.acc + '",' + JSON.stringify(o).slice(1);
                }))).filter(Boolean).join(',');
                return reply('{"totals":' + JSON.stringify(ct.results[0]) + ',"arenas":[' + arenas + '],"saves":[' + saves + ']}');
            }
            if ((route === '/api/g/chats' || route === '/api/g/chat') && req.method === 'POST') {
                const key = env.ADMIN_KEY;
                if (!key) return reply({ error: 'falta configurar ADMIN_KEY en Cloudflare' }, 403);
                const b = await req.json().catch(() => ({}));
                if (b.key !== key) return reply({ error: 'clave incorrecta' }, 403);
                if (route === '/api/g/chats') {
                    const { results } = await db.prepare('SELECT g.pair, g.n, g.last, g.a, g.b, pa.name AS na, pb.name AS nb, (SELECT txt FROM chat WHERE id = g.last) AS lt, (SELECT ts FROM chat WHERE id = g.last) AS lts FROM (SELECT pair, COUNT(*) AS n, MAX(id) AS last, MIN(a) AS a, MIN(b) AS b FROM chat GROUP BY pair ORDER BY last DESC LIMIT 300) g LEFT JOIN profiles pa ON pa.acc = g.a LEFT JOIN profiles pb ON pb.acc = g.b ORDER BY g.last DESC').all();
                    return reply({ chats: results });
                }
                const pair = String(b.pair || '');
                if (!/^[a-f0-9]{8}:[a-f0-9]{8}$/.test(pair)) return reply({ error: 'conversación no válida' }, 400);
                const [ms, pr] = await db.batch([
                    db.prepare('SELECT id, frm, ts, txt FROM (SELECT id, frm, ts, txt FROM chat WHERE pair = ?1 ORDER BY id DESC LIMIT 3000) ORDER BY id').bind(pair),
                    db.prepare('SELECT acc, name, avatar FROM profiles WHERE acc IN (?1, ?2)').bind(pair.slice(0, 8), pair.slice(9)),
                ]);
                return reply({ msgs: ms.results, profiles: pr.results });
            }
            if (route === '/api/g/save' && req.method === 'GET') { // la Caja de una partida del registro
                const row = await db.prepare('SELECT pc FROM g_saves WHERE id = ?1').bind(url.searchParams.get('k') || '').first();
                return reply('{"pc":' + ((row && row.pc) || 'null') + '}');
            }
            if (route === '/api/g/arena' && req.method === 'GET') {
                const row = await db.prepare('SELECT body FROM g_arenas WHERE k = ?1').bind(url.searchParams.get('k') || '').first();
                return row ? reply(row.body) : reply({ error: 'no existe' }, 404);
            }
            // ---- regalos: la consola de desarrollador envía (exige ADMIN_KEY); cada cuenta recoge lo suyo ----
            if (route === '/api/g/gift' && req.method === 'POST') {
                const key = env.ADMIN_KEY;
                if (!key) return reply({ error: 'falta configurar ADMIN_KEY en Cloudflare' }, 403);
                const t = await req.text(); if (t.length > 400000) return reply({ error: 'demasiado grande' }, 413);
                let b; try { b = JSON.parse(t); } catch (e) { return reply({ error: 'json no válido' }, 400); }
                if (!isObj(b) || b.key !== key) return reply({ error: 'clave incorrecta' }, 403);
                const to = b.to === '*' ? '*' : String(b.to || '').toLowerCase();
                if (to !== '*' && !/^[a-f0-9]{8}$/.test(to)) return reply({ error: 'cuenta no válida' }, 400);
                if (to !== '*' && !(await db.prepare('SELECT 1 FROM accounts WHERE substr(h, 1, 8) = ?1').bind(to).first())) return reply({ error: 'esa cuenta no existe' }, 404);
                const mons = (Array.isArray(b.mons) ? b.mons : []).filter(isObj).slice(0, 40).filter(m => JSON.stringify(m).length < 4000);
                const items = (Array.isArray(b.items) ? b.items : []).filter(i => isObj(i) && typeof i.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(i.id)).slice(0, 30).map(i => ({ id: i.id, n: Math.max(1, Math.min(99, i.n | 0)) }));
                if (!mons.length && !items.length) return reply({ error: 'regalo vacío' }, 400);
                const msg = typeof b.msg === 'string' ? b.msg.slice(0, 120) : '';
                const id = Date.now().toString(36) + hex(crypto.getRandomValues(new Uint8Array(4))), now = Date.now();
                const st = [db.prepare('INSERT INTO gifts (id, acc, ts, body) VALUES (?1, ?2, ?3, ?4)').bind(id, to, now, JSON.stringify({ mons, items, msg, dex: !!b.dex }))];
                if (Math.random() < 0.05) st.push(db.prepare('DELETE FROM gifts WHERE ts < ?1').bind(now - 30 * 864e5), db.prepare('DELETE FROM gift_claims WHERE gid NOT IN (SELECT id FROM gifts)'));
                await db.batch(st);
                return reply({ ok: true, id });
            }
            if (route === '/api/gifts' && req.method === 'GET') { // regalos pendientes de ESTA cuenta (los generales solo los ven las cuentas creadas antes de enviarse)
                const me = await db.prepare('SELECT created FROM accounts WHERE h = ?1').bind(h).first();
                const { results } = await db.prepare("SELECT id, ts, body FROM gifts WHERE (acc = ?1 OR (acc = '*' AND ts >= ?3)) AND ts > ?4 AND NOT EXISTS (SELECT 1 FROM gift_claims c WHERE c.gid = gifts.id AND c.h = ?2) ORDER BY ts LIMIT 10")
                    .bind(h.slice(0, 8), h, (me && me.created) || 0, Date.now() - 30 * 864e5).all();
                return reply('{"gifts":[' + results.map(r => '{"id":"' + r.id + '","ts":' + r.ts + ',"body":' + r.body + '}').join(',') + ']}');
            }
            if (route === '/api/gifts/ack' && req.method === 'POST') {
                const b = await req.json().catch(() => ({}));
                const ids = (Array.isArray(b.ids) ? b.ids : []).filter(x => typeof x === 'string' && /^[a-z0-9]{1,20}$/.test(x)).slice(0, 20);
                if (ids.length) await db.batch(ids.map(id => db.prepare('INSERT OR IGNORE INTO gift_claims (gid, h) VALUES (?1, ?2)').bind(id, h)));
                return reply({ ok: true });
            }
            if (route === '/api/g/slotcopy' && req.method === 'POST') { // consola de desarrollador: lee ('get') o reemplaza ('set') una ranura ENTERA de cualquier cuenta. Cuerpo de texto: op\nclave\ncuenta\nranura\n[partida]
                const key = env.ADMIN_KEY;
                if (!key) return reply({ error: 'falta configurar ADMIN_KEY en Cloudflare' }, 403);
                const t = await req.text(); if (t.length > MAX_BODY + 1000) return reply({ error: 'demasiado grande' }, 413);
                const head = []; let p = 0;
                for (let i = 0; i < 4; i++) { const j = t.indexOf('\n', p); if (j < 0) return reply({ error: 'petición no válida' }, 400); head.push(t.slice(p, j)); p = j + 1; }
                const op = head[0], acc = head[2], slot = head[3], body = t.slice(p);
                if (head[1] !== key) return reply({ error: 'clave incorrecta' }, 403);
                if (!/^[a-f0-9]{8}$/.test(acc) || !/^[123]$/.test(slot) || (op !== 'get' && op !== 'set')) return reply({ error: 'petición no válida' }, 400);
                const row = await db.prepare('SELECT h FROM accounts WHERE substr(h, 1, 8) = ?1').bind(acc).first();
                if (!row) return reply({ error: 'esa cuenta no existe' }, 404);
                if (op === 'get') {
                    const txt = await readKey(db, row.h, 'slot' + slot);
                    return txt ? reply('{"ok":true,"slot":' + txt + '}') : reply({ error: 'esa ranura está vacía' }, 404);
                }
                if (body[0] !== '{' || !body.includes('"data"')) return reply({ error: 'partida no válida' }, 400);
                await writeKey(db, row.h, 'slot' + slot, body);
                const cm = /"pokearena\.savecode"\s*:\s*"([A-Z0-9]{12})"/.exec(body);
                if (cm) await db.batch([
                    db.prepare('DELETE FROM save_codes WHERE h = ?1 AND slot = ?2 AND code <> ?3').bind(row.h, +slot, cm[1]),
                    db.prepare('INSERT OR REPLACE INTO save_codes (code, h, slot, ts) VALUES (?1, ?2, ?3, ?4)').bind(cm[1], row.h, +slot, Date.now()),
                ]);
                return reply({ ok: true });
            }
            if (route === '/api/g/clear' && req.method === 'POST') {
                const key = env.ADMIN_KEY;
                if (!key) return reply({ error: 'falta configurar ADMIN_KEY en Cloudflare' }, 403);
                const b = await req.json().catch(() => ({}));
                if (b.key !== key) return reply({ error: 'clave incorrecta' }, 403);
                if (b.what === 'arenas') await db.prepare('DELETE FROM g_arenas').run();
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
            if (route === '/api/loadcode' && req.method === 'POST') { // devuelve la partida que tiene ese código (el código actúa como llave)
                let b = null; try { b = await req.json(); } catch (e) {}
                const code = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
                if (code.length !== 12) return reply({ error: 'código no válido' }, 400);
                const row = await db.prepare('SELECT h, slot FROM save_codes WHERE code = ?1').bind(code).first();
                const txt = row ? await readKey(db, row.h, 'slot' + row.slot) : null;
                if (!txt || !txt.includes('"' + code + '"')) return reply({ error: 'no existe' }, 404);
                return reply('{"ok":true,"slot":' + txt + '}');
            }
            const s = /^\/api\/slot\/([123])$/.exec(route);
            if (s) {
                if (req.method === 'PUT') {
                    const t = await req.text();
                    if (t.length > MAX_BODY || t[0] !== '{' || !t.includes('"data"')) return reply({ error: 'partida no válida' }, 400);
                    await writeKey(db, h, 'slot' + s[1], t);
                    const cm = /"pokearena\.savecode"\s*:\s*"([A-Z0-9]{12})"/.exec(t); // el código de la partida apunta a la última cuenta/ranura que la guardó
                    if (cm) await db.batch([
                        db.prepare('DELETE FROM save_codes WHERE h = ?1 AND slot = ?2 AND code <> ?3').bind(h, +s[1], cm[1]),
                        db.prepare('INSERT OR REPLACE INTO save_codes (code, h, slot, ts) VALUES (?1, ?2, ?3, ?4)').bind(cm[1], h, +s[1], Date.now()),
                    ]);
                    return reply({ ok: true });
                }
                if (req.method === 'DELETE') { await db.batch([db.prepare('DELETE FROM blobs WHERE h = ?1 AND k = ?2').bind(h, 'slot' + s[1]), db.prepare('DELETE FROM save_codes WHERE h = ?1 AND slot = ?2').bind(h, +s[1])]); return reply({ ok: true }); }
            }
            return reply({ error: 'no existe' }, 404);
        } catch (e) { return reply({ error: 'error del servidor' }, 500); }
    },
};
