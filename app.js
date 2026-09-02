const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('node:crypto');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 8000;
const dbPath = process.env.DB_PATH || path.join(__dirname, 'api-database.sqlite');
const DEFAULT_TOKEN = process.env.LOGIN_TOKEN || '550e8400-e29b-41d4-a716-446655440000';
const MAX_TEXT_LENGTH = 500;
const ALLOWED_SORT_FIELDS = new Set(['id', 'nome', 'tipo', 'nota']);

let databaseInitialized = false;
let server;

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao SQLite:', err.message);
    } else {
        console.log(`Conectado ao banco de dados SQLite em ${dbPath}.`);
    }
});
db.configure('busyTimeout', 5000);

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function initializeDatabase() {
    await run('PRAGMA foreign_keys = ON');
    await run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
    )`);
    await run(`CREATE TABLE IF NOT EXISTS jogos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo TEXT NOT NULL,
        nota REAL NOT NULL CHECK (nota >= 0 AND nota <= 10),
        review TEXT NOT NULL
    )`);
    await run(
        'INSERT OR IGNORE INTO usuarios (id, email, password) VALUES (?, ?, ?)',
        [1, 'usuario@esoft.com', 'Abc123']
    );
    databaseInitialized = true;
}

function validateId(rawId) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
        return { error: 'O ID deve ser um número inteiro positivo.' };
    }
    return { value: id };
}

function normalizeText(value, field) {
    if (typeof value !== 'string') {
        return { error: `O campo '${field}' deve ser um texto.` };
    }
    const normalized = value.trim();
    if (!normalized) {
        return { error: `O campo '${field}' não pode ficar vazio.` };
    }
    if (normalized.length > MAX_TEXT_LENGTH) {
        return { error: `O campo '${field}' deve ter no máximo ${MAX_TEXT_LENGTH} caracteres.` };
    }
    return { value: normalized };
}

function validateGamePayload(payload, { partial = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { error: 'O corpo da requisição deve ser um objeto JSON.' };
    }

    const fields = ['nome', 'tipo', 'nota', 'review'];
    const missing = fields.filter((field) => !partial && !Object.hasOwn(payload, field));
    if (missing.length > 0) {
        return { error: `Campos obrigatórios ausentes: ${missing.join(', ')}.` };
    }
    if (partial && !fields.some((field) => Object.hasOwn(payload, field))) {
        return { error: 'Informe ao menos um campo para atualizar.' };
    }

    const value = {};
    for (const field of fields) {
        if (!Object.hasOwn(payload, field)) continue;
        if (field === 'nota') {
            if (typeof payload.nota !== 'number' || !Number.isFinite(payload.nota)) {
                return { error: "O campo 'nota' deve ser um número válido." };
            }
            if (payload.nota < 0 || payload.nota > 10) {
                return { error: 'A nota deve ser um valor entre 0 e 10.' };
            }
            value.nota = payload.nota;
            continue;
        }
        const result = normalizeText(payload[field], field);
        if (result.error) return result;
        value[field] = result.value;
    }
    return { value };
}

function parseListOptions(query) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(page) || page < 1) {
        return { error: 'O parâmetro page deve ser um inteiro maior que zero.' };
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return { error: 'O parâmetro limit deve ser um inteiro entre 1 e 100.' };
    }

    const sortBy = query.sortBy || 'id';
    if (!ALLOWED_SORT_FIELDS.has(sortBy)) {
        return { error: `sortBy deve ser um destes valores: ${[...ALLOWED_SORT_FIELDS].join(', ')}.` };
    }
    const order = (query.order || 'desc').toLowerCase();
    if (!['asc', 'desc'].includes(order)) {
        return { error: "O parâmetro order deve ser 'asc' ou 'desc'." };
    }

    const where = [];
    const params = [];
    if (query.q) {
        where.push('(nome LIKE ? OR review LIKE ?)');
        const search = `%${String(query.q).trim()}%`;
        params.push(search, search);
    }
    if (query.tipo) {
        where.push('tipo = ?');
        params.push(String(query.tipo).trim());
    }
    for (const field of ['minNota', 'maxNota']) {
        if (query[field] === undefined) continue;
        const nota = Number(query[field]);
        if (!Number.isFinite(nota) || nota < 0 || nota > 10) {
            return { error: `${field} deve ser um número entre 0 e 10.` };
        }
        where.push(`nota ${field === 'minNota' ? '>=' : '<='} ?`);
        params.push(nota);
    }

    return {
        value: {
            page,
            limit,
            offset: (page - 1) * limit,
            where: where.length ? `WHERE ${where.join(' AND ')}` : '',
            params,
            sortBy,
            order: order.toUpperCase()
        }
    };
}

function gameError(res, error, fallback = 'Erro interno do servidor.') {
    console.error(error.message || error);
    return res.status(500).json({ error: fallback });
}

app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '50kb' }));

app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const startedAt = Date.now();
    res.on('finish', () => {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms [${req.requestId}]`);
    });
    next();
});

app.get('/health', (req, res) => {
    const healthy = databaseInitialized;
    return res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'starting',
        database: healthy ? 'ready' : 'initializing',
        uptime: Math.round(process.uptime()),
        requestId: req.requestId
    });
});

app.post('/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    }

    try {
        const user = await get('SELECT email, password FROM usuarios WHERE email = ?', [email]);
        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        return res.status(200).json({ token: DEFAULT_TOKEN });
    } catch (error) {
        return gameError(res, error, 'Erro ao autenticar usuário.');
    }
});

app.get('/jogos', async (req, res) => {
    const hasQuery = Object.keys(req.query).length > 0;
    if (!hasQuery) {
        try {
            const rows = await all('SELECT * FROM jogos ORDER BY id DESC');
            return res.status(200).json(rows);
        } catch (error) {
            return gameError(res, error);
        }
    }

    const options = parseListOptions(req.query);
    if (options.error) return res.status(400).json({ error: options.error });
    const { page, limit, offset, where, params, sortBy, order } = options.value;
    try {
        const totalRow = await get(`SELECT COUNT(*) AS total FROM jogos ${where}`, params);
        const rows = await all(
            `SELECT * FROM jogos ${where} ORDER BY ${sortBy} ${order} LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        return res.status(200).json({
            data: rows,
            pagination: {
                page,
                limit,
                total: totalRow.total,
                totalPages: Math.ceil(totalRow.total / limit),
                hasNextPage: offset + rows.length < totalRow.total
            }
        });
    } catch (error) {
        return gameError(res, error);
    }
});

app.get('/jogos/stats', async (req, res) => {
    try {
        const summary = await get(`
            SELECT COUNT(*) AS total,
                   ROUND(COALESCE(AVG(nota), 0), 2) AS media,
                   COALESCE(MIN(nota), 0) AS menorNota,
                   COALESCE(MAX(nota), 0) AS maiorNota
            FROM jogos
        `);
        const byType = await all(`
            SELECT tipo, COUNT(*) AS quantidade,
                   ROUND(AVG(nota), 2) AS media
            FROM jogos
            GROUP BY tipo
            ORDER BY quantidade DESC, tipo ASC
        `);
        return res.status(200).json({ ...summary, porTipo: byType });
    } catch (error) {
        return gameError(res, error);
    }
});

app.get('/jogos/:id', async (req, res) => {
    const parsedId = validateId(req.params.id);
    if (parsedId.error) return res.status(400).json({ error: parsedId.error });
    try {
        const row = await get('SELECT * FROM jogos WHERE id = ?', [parsedId.value]);
        if (!row) return res.status(404).json({ error: 'Jogo não encontrado.' });
        return res.status(200).json(row);
    } catch (error) {
        return gameError(res, error);
    }
});

app.post('/jogos', async (req, res) => {
    const validation = validateGamePayload(req.body);
    if (validation.error) return res.status(400).json({ error: validation.error });
    const { nome, tipo, nota, review } = validation.value;
    try {
        const result = await run(
            'INSERT INTO jogos (nome, tipo, nota, review) VALUES (?, ?, ?, ?)',
            [nome, tipo, nota, review]
        );
        return res.status(201).json({ id: result.lastID, nome, tipo, nota, review });
    } catch (error) {
        return gameError(res, error, 'Erro ao salvar no banco de dados.');
    }
});

app.put('/jogos/:id', async (req, res) => {
    const parsedId = validateId(req.params.id);
    if (parsedId.error) return res.status(400).json({ error: parsedId.error });
    const validation = validateGamePayload(req.body);
    if (validation.error) {
        return res.status(400).json({ error: `Todos os campos são obrigatórios para a atualização. ${validation.error}` });
    }
    const { nome, tipo, nota, review } = validation.value;
    try {
        const result = await run(
            'UPDATE jogos SET nome = ?, tipo = ?, nota = ?, review = ? WHERE id = ?',
            [nome, tipo, nota, review, parsedId.value]
        );
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Jogo não encontrado para atualização.' });
        }
        return res.status(200).json({ id: parsedId.value, nome, tipo, nota, review });
    } catch (error) {
        return gameError(res, error, 'Erro ao atualizar no banco de dados.');
    }
});

app.patch('/jogos/:id', async (req, res) => {
    const parsedId = validateId(req.params.id);
    if (parsedId.error) return res.status(400).json({ error: parsedId.error });
    const validation = validateGamePayload(req.body, { partial: true });
    if (validation.error) return res.status(400).json({ error: validation.error });
    const fields = Object.keys(validation.value);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => validation.value[field]);
    try {
        const result = await run(
            `UPDATE jogos SET ${assignments} WHERE id = ?`,
            [...values, parsedId.value]
        );
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Jogo não encontrado para atualização.' });
        }
        const updated = await get('SELECT * FROM jogos WHERE id = ?', [parsedId.value]);
        return res.status(200).json(updated);
    } catch (error) {
        return gameError(res, error, 'Erro ao atualizar no banco de dados.');
    }
});

app.delete('/jogos/:id', async (req, res) => {
    const parsedId = validateId(req.params.id);
    if (parsedId.error) return res.status(400).json({ error: parsedId.error });
    try {
        const result = await run('DELETE FROM jogos WHERE id = ?', [parsedId.value]);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Jogo não encontrado para exclusão.' });
        }
        return res.status(204).send();
    } catch (error) {
        return gameError(res, error);
    }
});

app.use((req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.', requestId: req.requestId });
});

app.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'O corpo da requisição contém JSON inválido.', requestId: req.requestId });
    }
    console.error('Erro não tratado:', error);
    return res.status(500).json({ error: 'Erro interno do servidor.', requestId: req.requestId });
});

function closeDatabase() {
    return new Promise((resolve, reject) => {
        db.close((error) => (error ? reject(error) : resolve()));
    });
}

async function startServer() {
    await initializeDatabase();
    server = app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}.`));
    return server;
}

async function shutdown(signal) {
    console.log(`Recebido ${signal}; encerrando servidor...`);
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await closeDatabase();
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error('Não foi possível iniciar a aplicação:', error);
        process.exitCode = 1;
    });
    process.once('SIGINT', () => shutdown('SIGINT').catch(console.error));
    process.once('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
}

module.exports = { app, db, initializeDatabase, closeDatabase, startServer };
