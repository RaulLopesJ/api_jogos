const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// ==========================================
// CONFIGURAÇÃO DO BANCO DE DADOS (SQLITE)
// ==========================================
const dbPath = './api-database.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao SQLite:', err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
    }
});

db.serialize(() => {
    // Criação da tabela de usuários
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT
    )`);

    // Criação da tabela de jogos
    db.run(`CREATE TABLE IF NOT EXISTS jogos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        nome TEXT, 
        tipo TEXT, 
        nota REAL, 
        review TEXT
    )`);

    // Insere o usuário padrão exigido no documento
    const stmt = db.prepare(`INSERT OR IGNORE INTO usuarios (id, email, password) VALUES (?, ?, ?)`);
    stmt.run(1, 'usuario@esoft.com', 'Abc123');
    stmt.finalize();
});

// ==========================================
// ENDPOINT DE AUTENTICAÇÃO
// ==========================================

// POST /login
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    // Regra rigorosa do documento
    if (email === 'usuario@esoft.com' && password === 'Abc123') {
        return res.status(200).json({ "token": "550e8400-e29b-41d4-a716-446655440000" });
    } else {
        return res.status(401).json({ error: "Credenciais inválidas." });
    }
});

// ==========================================
// ENDPOINTS DE JOGOS (CRUD)
// ==========================================

// GET /jogos - Retorna a lista completa
app.get('/jogos', (req, res) => {
    // Utilizado db.all para pegar todos os registros
    db.all(`SELECT * FROM jogos`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
        // Retorna o array diretamente, conforme exigido no PDF
        return res.status(200).json(rows);
    });
});

// GET /jogos/{id} - Busca um jogo específico
app.get('/jogos/:id', (req, res) => {
    const id = req.params.id;
    
    // Utilizado db.get para pegar apenas 1 registro
    db.get(`SELECT * FROM jogos WHERE id = ?`, [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
        if (!row) {
            return res.status(404).json({ error: "Jogo não encontrado." });
        }
        return res.status(200).json(row);
    });
});

// POST /jogos - Cadastra um novo jogo
app.post('/jogos', (req, res) => {
    const { nome, tipo, nota, review } = req.body;
    
    // Defesa 1: Verifica se falta algum campo
    if (!nome || !tipo || nota === undefined || !review) {
        return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    // Defesa 2: Verifica se a nota NÃO é um número
    if (typeof nota !== 'number') {
        return res.status(400).json({ error: "O campo 'nota' deve ser um número válido." });
    }

    // Defesa 3: Verifica se a nota está entre 0 e 10
    if (nota < 0 || nota > 10) {
        return res.status(400).json({ error: "A nota deve ser um valor entre 0 e 10." });
    }

    // Só chega aqui se passou por TODAS as defesas. Agora sim, salvamos no banco.
    const query = `INSERT INTO jogos (nome, tipo, nota, review) VALUES (?, ?, ?, ?)`;
    
    db.run(query, [nome, tipo, nota, review], function(err) {
        if (err) {
            return res.status(500).json({ error: "Erro ao salvar no banco de dados." });
        }
        
        return res.status(201).json({
            id: this.lastID,
            nome,
            tipo,
            nota,
            review
        });
    });
});
// PUT /jogos/{id} - Atualiza um jogo existente
app.put('/jogos/:id', (req, res) => {
    const id = req.params.id;
    const { nome, tipo, nota, review } = req.body;

    // Defesa para os testes cruzados: O documento diz "Obrigatório preencher todos os campos"
    if (!nome || !tipo || nota === undefined || !review) {
        return res.status(400).json({ error: "Todos os campos são obrigatórios para a atualização." });
    }

    const query = `UPDATE jogos SET nome = ?, tipo = ?, nota = ?, review = ? WHERE id = ?`;
    
    db.run(query, [nome, tipo, nota, review, id], function(err) {
        if (err) {
            return res.status(500).json({ error: "Erro ao atualizar no banco de dados." });
        }
        
        // Se nenhuma linha foi alterada, o ID não existe
        if (this.changes === 0) {
            return res.status(404).json({ error: "Jogo não encontrado para atualização." });
        }

        // Retorna status 200 OK com o objeto atualizado
        return res.status(200).json({
            id: Number(id),
            nome,
            tipo,
            nota,
            review
        });
    });
});

// DELETE /jogos/{id} - Remove o jogo
app.delete('/jogos/:id', (req, res) => {
    const id = req.params.id;
    
    db.run(`DELETE FROM jogos WHERE id = ?`, [id], function(err) {
        if (err) {
            return res.status(500).json({ error: "Erro interno do servidor." });
        }
        
        // Retorna 204 No Content (exige não ter corpo de resposta)
        return res.status(204).send();
    });
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});