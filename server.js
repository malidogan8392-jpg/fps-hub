// ── FPS Game Hub Backend ──────────────────────────────────────
// Bu küçük sunucunun TEK işi:
//   1) Hesap login/register/save işlemlerini GitHub'daki accounts.json
//      dosyasına yazmak (GITHUB_TOKEN burada, sunucu tarafında, GİZLİ kalır —
//      GitHub Pages'teki statik istemci koduna asla konmaz).
//   2) P2P sunucu kayıt defteri (registry): host'lar kendilerini buraya
//      kaydeder/heartbeat atar, istemciler "Hızlı Oyna" ve
//      "Community Servers" için buradan liste çeker.
// Oyunun kendisi (hareket/ateş/hasar/oda mantığı) burada YOK — o tamamen
// istemciler arası PeerJS (WebRTC) ile P2P olarak, host'un tarayıcısında
// çalışıyor. Bu sunucu sadece "telefon rehberi" gibi davranıyor.

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// CORS: GitHub Pages'ten (farklı origin) istek gelecek
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Ayarlar ────────────────────────────────────────────────────
const GH_TOKEN = process.env.GITHUB_TOKEN;           // repo'ya "contents: write" yetkili, fine-grained, SADECE bu repo için token
const GH_REPO = process.env.GITHUB_REPO;             // "kullaniciadi/repo-adi"
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GH_FILE_PATH = process.env.GITHUB_ACCOUNTS_PATH || 'accounts.json';
const GH_API = GH_REPO ? `https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE_PATH}` : null;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please-' + Math.random(); // .env'de mutlaka kendi değerini koy

if (!GH_TOKEN || !GH_REPO) {
    console.warn('⚠️ GITHUB_TOKEN / GITHUB_REPO tanımlı değil — hesap işlemleri çalışmayacak.');
}
if (!process.env.SESSION_SECRET) {
    console.warn('⚠️ SESSION_SECRET tanımlı değil — geçici rastgele bir secret kullanılıyor (her restart\'ta oturumlar geçersiz olur). Render/Railway env variable olarak SESSION_SECRET eklemen önerilir.');
}

function hashPwd(p) { return crypto.createHash('sha256').update(String(p || '') + ':fps2024').digest('hex'); }

function signSession(username) {
    const payload = Buffer.from(username).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}
function verifySession(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (sig !== expected) return null;
    try { return Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
}

// ── GitHub'daki accounts.json ile konuşma ───────────────────────
let cachedSha = null;
async function ghGet() {
    const res = await fetch(`${GH_API}?ref=${GH_BRANCH}`, {
        headers: { 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (res.status === 404) { cachedSha = null; return {}; }
    if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cachedSha = data.sha;
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content.trim() ? JSON.parse(content) : {};
}

async function ghPut(accounts, message) {
    const content = Buffer.from(JSON.stringify(accounts, null, 2)).toString('base64');
    const res = await fetch(GH_API, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${GH_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, content, branch: GH_BRANCH, sha: cachedSha || undefined })
    });
    if (res.status === 409 || res.status === 422) {
        // sha uyuşmadı: güncelini çekip bir kere daha dene
        await ghGet();
        return ghPut(accounts, message);
    }
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cachedSha = data.content.sha;
}

// Eşzamanlı yazmaları sıraya koymak için basit bir kilit (aynı anda 2 kayıt
// GitHub'a yazmaya çalışırsa sha çakışmasını önler)
let writeQueue = Promise.resolve();
function withWriteLock(fn) {
    const result = writeQueue.then(fn, fn);
    writeQueue = result.catch(() => {});
    return result;
}

// ── Rotalar: Hesap ──────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    try {
        const user = String(req.body.user || '').trim().toLowerCase();
        const pwd = String(req.body.pwd || '');
        if (!user || user.length < 3) return res.status(400).json({ error: 'Kullanıcı adı en az 3 karakter olmalı.' });
        if (!pwd || pwd.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });

        await withWriteLock(async () => {
            const accounts = await ghGet();
            if (accounts[user]) throw Object.assign(new Error('Bu kullanıcı adı zaten alınmış.'), { code: 409 });
            accounts[user] = { pwdHash: hashPwd(pwd), killPoints: 0, unlockedWeapons: ['glock'], unlockedChars: ['soldier'] };
            await ghPut(accounts, `👤 yeni hesap: ${user}`);
        });

        res.json({ ok: true, token: signSession(user), username: user, killPoints: 0, unlockedWeapons: ['glock'], unlockedChars: ['soldier'] });
    } catch (e) {
        res.status(e.code || 500).json({ error: e.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const user = String(req.body.user || '').trim().toLowerCase();
        const pwd = String(req.body.pwd || '');
        const accounts = await ghGet();
        const acc = accounts[user];
        if (!acc || acc.pwdHash !== hashPwd(pwd)) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
        res.json({
            ok: true, token: signSession(user), username: user,
            killPoints: acc.killPoints || 0,
            unlockedWeapons: acc.unlockedWeapons || ['glock'],
            unlockedChars: acc.unlockedChars || ['soldier']
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Oyun bitince / mağazadan alışverişte host bu uç noktayı çağırıp
// oyuncunun ilerlemesini kaydeder. `token` login/register'dan gelen imzalı token.
app.post('/api/save', async (req, res) => {
    try {
        const { token, killPoints, unlockedWeapons, unlockedChars } = req.body;
        const user = verifySession(token);
        if (!user) return res.status(401).json({ error: 'Geçersiz oturum.' });

        await withWriteLock(async () => {
            const accounts = await ghGet();
            if (!accounts[user]) throw Object.assign(new Error('Hesap bulunamadı.'), { code: 404 });
            if (typeof killPoints === 'number') accounts[user].killPoints = killPoints;
            if (Array.isArray(unlockedWeapons)) accounts[user].unlockedWeapons = unlockedWeapons;
            if (Array.isArray(unlockedChars)) accounts[user].unlockedChars = unlockedChars;
            await ghPut(accounts, `💾 ilerleme güncellendi: ${user}`);
        });

        res.json({ ok: true });
    } catch (e) {
        res.status(e.code || 500).json({ error: e.message });
    }
});

// ── Rotalar: P2P Sunucu Kayıt Defteri (Registry) ────────────────
// Bellekte tutulur (hafif, kalıcı olmasına gerek yok — host kapanınca zaten
// düşmesi lazım). Her host, PeerJS peer ID'sini kendi "hostToken"ı ile
// kaydeder; sadece o token'ı bilen (yani kaydı yapan) host kendi kaydını
// güncelleyip silebilir.
const servers = new Map(); // peerId -> { name, mode, players, maxPlayers, map, hostToken, lastSeen }
const HEARTBEAT_TTL_MS = 20000; // 20sn heartbeat gelmezse sunucu listeden düşer

function pruneServers() {
    const now = Date.now();
    for (const [peerId, s] of servers) {
        if (now - s.lastSeen > HEARTBEAT_TTL_MS) servers.delete(peerId);
    }
}
setInterval(pruneServers, 5000);

app.post('/api/servers/heartbeat', (req, res) => {
    const { peerId, hostToken, name, mode, players, maxPlayers, map, phase } = req.body;
    if (!peerId || !hostToken) return res.status(400).json({ error: 'peerId ve hostToken gerekli.' });

    const existing = servers.get(peerId);
    if (existing && existing.hostToken !== hostToken) {
        return res.status(403).json({ error: 'Bu sunucu başka bir host tarafından kayıtlı.' });
    }
    servers.set(peerId, {
        peerId, hostToken,
        name: String(name || 'İsimsiz Sunucu').slice(0, 40),
        mode: mode === 'community' ? 'community' : 'public',
        players: Number(players) || 0,
        maxPlayers: Number(maxPlayers) || 16,
        map: String(map || '?'),
        phase: String(phase || 'playing'),
        lastSeen: Date.now()
    });
    res.json({ ok: true });
});

app.delete('/api/servers/:peerId', (req, res) => {
    const s = servers.get(req.params.peerId);
    if (!s) return res.json({ ok: true });
    if (s.hostToken !== req.body?.hostToken && s.hostToken !== req.query?.hostToken) {
        return res.status(403).json({ error: 'Yetkisiz.' });
    }
    servers.delete(req.params.peerId);
    res.json({ ok: true });
});

// Hızlı Oyna: dolu olmayan rastgele bir public sunucu döner, yoksa null
app.get('/api/servers/quick', (req, res) => {
    pruneServers();
    const candidates = [...servers.values()].filter(s => s.mode === 'public' && s.players < s.maxPlayers);
    if (candidates.length === 0) return res.json({ server: null });
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    res.json({ server: pick });
});

// Community Servers: tüm açık sunucuları listeler (public + community)
app.get('/api/servers/list', (req, res) => {
    pruneServers();
    res.json({ servers: [...servers.values()].sort((a, b) => b.players - a.players) });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`🌐 Hub backend çalışıyor: http://localhost:${PORT}`));
