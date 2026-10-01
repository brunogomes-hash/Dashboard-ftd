const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Endpoint que calcula os indicadores filtrando apenas endereços Ativos e de Estado Normal
app.get('/api/dashboard', async (req, res) => {
  try {
    // 1. Totais Gerais
    const gerais = await pool.query(`
      SELECT 
        COALESCE(SUM(quantidade), 0) AS total_estoque,
        COUNT(DISTINCT sku) AS total_skus,
        COUNT(DISTINCT id_posicao) AS total_posicoes,
        COUNT(DISTINCT CASE WHEN quantidade > 0 THEN id_posicao END) AS posicoes_ocupadas,
        COUNT(DISTINCT CASE WHEN quantidade = 0 OR quantidade IS NULL THEN id_posicao END) AS posicoes_vazias
      FROM estoque
      WHERE status = 'ATIVO' AND estado = 'NORMAL'
    `);

    // 2. Ocupação Picking
    const picking = await pool.query(`
      SELECT 
        COALESCE(SUM(quantidade), 0) AS total_pecas,
        COUNT(DISTINCT sku) AS total_skus,
        COUNT(DISTINCT id_posicao) AS capacidade,
        COUNT(DISTINCT CASE WHEN quantidade > 0 THEN id_posicao END) AS ocupadas,
        COUNT(DISTINCT CASE WHEN quantidade = 0 OR quantidade IS NULL THEN id_posicao END) AS vazias
      FROM estoque
      WHERE status = 'ATIVO' AND estado = 'NORMAL' AND tipo_posicao ILIKE '%PICKING%'
    `);

    // 3. Ocupação Pulmão
    const pulmao = await pool.query(`
      SELECT 
        COALESCE(SUM(quantidade), 0) AS total_pecas,
        COUNT(DISTINCT sku) AS total_skus,
        COUNT(DISTINCT id_posicao) AS capacidade,
        COUNT(DISTINCT CASE WHEN quantidade > 0 THEN id_posicao END) AS ocupadas,
        COUNT(DISTINCT CASE WHEN quantidade = 0 OR quantidade IS NULL THEN id_posicao END) AS vazias
      FROM estoque
      WHERE status = 'ATIVO' AND estado = 'NORMAL' AND tipo_posicao ILIKE '%PULMÃO%'
    `);

    res.json({
      gerais: gerais.rows[0],
      picking: picking.rows[0],
      pulmao: pulmao.rows[0],
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro na consulta:', err);
    res.status(500).json({ error: 'Erro ao carregar dados do banco' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});