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

// ROUTE 1: ESTOQUE
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
    const pulmaoRows = rowsCapacidade.filter(r => r.categoria && r.categoria.includes('PP - PULMÃO'));

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
        capacidade: pickingRows.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0),
        ocupadas: pickingRows.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0),
        vazias: pickingRows.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0)
      },
      pulmao: {
        total_pecas: pulmaoPecas.rows[0]?.total_pecas || 0,
        total_skus: pulmaoPecas.rows[0]?.total_skus || 0,
        capacidade: pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0),
        ocupadas: pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0),
        vazias: pulmaoRows.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0)
      },
      graficos: rowsCapacidade,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro no Estoque', detalhe: err.message });
  }
});

// ROUTE 2: OUTBOUND GERAL (LAYOUT COMPLETO)
app.get('/api/outbound', async (req, res) => {
  try {
    const kpis = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_integradas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_integrados,
        
        COALESCE(SUM(CASE WHEN "coletado_em" IS NOT NULL THEN "quantidade" ELSE 0 END), 0) AS total_expedidas,
        COUNT(DISTINCT CASE WHEN "coletado_em" IS NOT NULL THEN "pedido_de_venda" END) AS pedidos_expedidos,

        COALESCE(SUM(CASE WHEN "processado_em" IS NOT NULL THEN "quantidade" ELSE 0 END), 0) AS total_produzidas,
        COUNT(DISTINCT CASE WHEN "processado_em" IS NOT NULL THEN "pedido_de_venda" END) AS pedidos_produzidos,

        COALESCE(SUM(CASE WHEN "status_da_nota_fiscal" ILIKE '%RETENÇÃO%' THEN "quantidade" ELSE 0 END), 0) AS total_tratativa,
        COUNT(DISTINCT CASE WHEN "status_da_nota_fiscal" ILIKE '%RETENÇÃO%' THEN "pedido_de_venda" END) AS pedidos_tratativa
      FROM "itens"
    `);

    const r = kpis.rows[0] || {};

    res.json({
      forecast_pecas: 0,
      pecas_integradas: Number(r.total_integradas || 0),
      pedidos_integradas: Number(r.pedidos_integrados || 0),
      pecas_fluxo: 0,
      pedidos_fluxo: 0,
      em_coleta: 0,
      pedidos_coleta: 0,
      em_tratativa: Number(r.total_tratativa || 0),
      pedidos_tratativa: Number(r.pedidos_tratativa || 0),
      pecas_produzidas: Number(r.total_produzidas || 0),
      pedidos_produzidas: Number(r.pedidos_produzidos || 0),
      pecas_expedidas: Number(r.total_expedidas || 0),
      pedidos_expedidas: Number(r.pedidos_expedidos || 0),
      sla_pct: 100.0,
      integrado_vs_fcst: 0.0,
      produzido_vs_fcst: 0.0,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro no Outbound:', err);
    res.status(500).json({ error: 'Erro no Outbound', detalhe: err.message });
  }
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => console.log(`Rodando na porta ${port}`));