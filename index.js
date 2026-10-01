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

// 1. ENDPOINT EXCLUSIVO PARA ESTOQUE (INDEPENDENTE)
app.get('/api/dashboard', async (req, res) => {
  try {
    const pecasEstoque = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_estoque,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
    `);

    const pickingPecas = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND "tipo_do_local" ILIKE '%PICKING%'
    `);

    const pulmaoPecas = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND ("tipo_do_local" ILIKE '%PULMÃO%' OR "tipo_do_local" ILIKE '%PULMAO%')
    `);

    const graficos = await pool.query(`
      SELECT 
        categoria_estrutura AS categoria,
        locais_livres_qtd AS posicoes_livres,
        locais_ocupados_qtd AS posicoes_ocupadas,
        locais_capacidade_qtd AS posicoes_capacidade,
        livres_unidades AS pecas_livres,
        ocupados_unidades_disponiveis AS pecas_ocupadas,
        capacidade_total_unidades AS pecas_capacidade
      FROM "capacidade_armazem"
      ORDER BY 
        CASE 
          WHEN categoria_estrutura = 'PR - PRATELEIRA' THEN 1
          WHEN categoria_estrutura = 'PQ - BLOCADO' THEN 2
          WHEN categoria_estrutura = 'PP - PULMÃO' THEN 3
          WHEN categoria_estrutura = 'PP - PICKING' THEN 4
          ELSE 5
        END
    `);

    const rowsCapacidade = graficos.rows || [];

    const totalPosicoesGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0);
    const totalOcupadasGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0);
    const totalVaziasGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0);

    const pickingRows = rowsCapacidade.filter(r => r.categoria && !r.categoria.includes('PP - PULMÃO'));
    const pickingCapacidade = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0);
    const pickingOcupadas = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0);
    const pickingVazias = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0);

    const pulmaoRows = rowsCapacidade.filter(r => r.categoria && r.categoria.includes('PP - PULMÃO'));
    const pulmaoCapacidade = pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0);
    const pulmaoOcupadas = pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0);
    const pulmaoVazias = pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0);

    res.json({
      gerais: {
        total_estoque: pecasEstoque.rows[0]?.total_estoque || 0,
        total_skus: pecasEstoque.rows[0]?.total_skus || 0,
        total_posicoes: totalPosicoesGeral,
        posicoes_ocupadas: totalOcupadasGeral,
        posicoes_vazias: totalVaziasGeral
      },
      picking: {
        total_pecas: pickingPecas.rows[0]?.total_pecas || 0,
        total_skus: pickingPecas.rows[0]?.total_skus || 0,
        capacidade: pickingCapacidade,
        ocupadas: pickingOcupadas,
        vazias: pickingVazias
      },
      pulmao: {
        total_pecas: pulmaoPecas.rows[0]?.total_pecas || 0,
        total_skus: pulmaoPecas.rows[0]?.total_skus || 0,
        capacidade: pulmaoCapacidade,
        ocupadas: pulmaoOcupadas,
        vazias: pulmaoVazias
      },
      graficos: rowsCapacidade,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro na API Estoque:', err);
    res.status(500).json({ error: 'Erro ao carregar Estoque', detalhe: err.message });
  }
});

// 2. ENDPOINT EXCLUSIVO PARA OUTBOUND - GERAL (TABELA ITENS)
app.get('/api/outbound', async (req, res) => {
  try {
    const outboundData = await pool.query(`
      SELECT 
        COUNT(DISTINCT "código_do_produto") AS total_skus,
        COALESCE(SUM("quantidade"), 0) AS total_quantidade,
        COUNT(DISTINCT "nota_fiscal") AS total_notas,
        COUNT(DISTINCT "pedido_de_venda") AS total_pedidos
      FROM "itens"
    `);

    res.json({
      total_skus: outboundData.rows[0]?.total_skus || 0,
      total_quantidade: outboundData.rows[0]?.total_quantidade || 0,
      total_notas: outboundData.rows[0]?.total_notas || 0,
      total_pedidos: outboundData.rows[0]?.total_pedidos || 0,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro na API Outbound:', err);
    res.status(500).json({ error: 'Erro ao carregar Outbound', detalhe: err.message });
  }
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});