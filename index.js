const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    // 1. Totais Gerais
    const gerais = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_estoque,
        COUNT(DISTINCT "código_do_produto") AS total_skus,
        COUNT(DISTINCT "id_local") AS total_posicoes,
        COUNT(DISTINCT CASE WHEN "disponível" > 0 THEN "id_local" END) AS posicoes_ocupadas,
        COUNT(DISTINCT CASE WHEN "disponível" = 0 OR "disponível" IS NULL THEN "id_local" END) AS posicoes_vazias
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
    `);

    // 2. Ocupação Picking
    const picking = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus,
        COUNT(DISTINCT "id_local") AS capacidade,
        COUNT(DISTINCT CASE WHEN "disponível" > 0 THEN "id_local" END) AS ocupadas,
        COUNT(DISTINCT CASE WHEN "disponível" = 0 OR "disponível" IS NULL THEN "id_local" END) AS vazias
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND "tipo_do_local" ILIKE '%PICKING%'
    `);

    // 3. Ocupação Pulmão
    const pulmao = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus,
        COUNT(DISTINCT "id_local") AS capacidade,
        COUNT(DISTINCT CASE WHEN "disponível" > 0 THEN "id_local" END) AS ocupadas,
        COUNT(DISTINCT CASE WHEN "disponível" = 0 OR "disponível" IS NULL THEN "id_local" END) AS vazias
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("tipo_do_local" ILIKE '%PULMÃO%' OR "tipo_do_local" ILIKE '%PULMAO%')
    `);

    res.json({
      gerais: gerais.rows[0],
      picking: picking.rows[0],
      pulmao: pulmao.rows[0],
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro na consulta:', err);
    res.status(500).json({ 
      error: 'Erro na consulta do banco', 
      detalhe: err.message 
    });
  }
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});