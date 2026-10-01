const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Conexão com o PostgreSQL no Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.static('public'));
app.use(express.json());

// ROTA ÚNICA: Estoque
app.get('/api/estoque', async (req, res) => {
  try {
    const queryEstoque = `
      SELECT 
        COALESCE(SUM(quantidade), 0) AS total_pecas,
        COALESCE(COUNT(DISTINCT sku), 0) AS total_skus,
        COALESCE(SUM(quantidade) FILTER (
          WHERE LOWER(COALESCE(tipo_posicao, '')) LIKE '%picking%' 
             OR pos_picking IS NOT NULL
        ), 0) AS pick_pecas,
        COALESCE(COUNT(DISTINCT sku) FILTER (
          WHERE LOWER(COALESCE(tipo_posicao, '')) LIKE '%picking%' 
             OR pos_picking IS NOT NULL
        ), 0) AS pick_sku,
        COALESCE(SUM(quantidade) FILTER (
          WHERE LOWER(COALESCE(tipo_posicao, '')) LIKE '%pulm%'
        ), 0) AS pul_pecas,
        COALESCE(COUNT(DISTINCT sku) FILTER (
          WHERE LOWER(COALESCE(tipo_posicao, '')) LIKE '%pulm%'
        ), 0) AS pul_sku
      FROM estoque;
    `;

    const result = await pool.query(queryEstoque);
    const row = result.rows[0] || {};

    res.json({
      total_estoque: Number(row.total_pecas || 0),
      total_skus: Number(row.total_skus || 0),
      picking: { pecas: Number(row.pick_pecas || 0), sku: Number(row.pick_sku || 0) },
      pulmao: { pecas: Number(row.pul_pecas || 0), sku: Number(row.pul_sku || 0) }
    });

  } catch (err) {
    console.error('Erro na consulta do estoque:', err.message);
    res.status(500).json({ error: 'Erro ao consultar banco de dados', detalhe: err.message });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});