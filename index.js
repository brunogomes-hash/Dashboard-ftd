const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Conexão com a base de dados do Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', async (req, res) => {
  try {
    // Faz uma consulta de teste ao banco de dados
    const result = await pool.query('SELECT NOW()');
    res.send(`
      <h1>🚀 Site no ar e conectado ao Neon!</h1>
      <p>Data/Hora do Banco de Dados: <strong>${result.rows[0].now}</strong></p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao conectar ao banco de dados Neon.');
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});