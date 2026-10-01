const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.static('public'));
app.use(express.json());

// ROTA ESTOQUE (Totalmente isolada na tabela 'estoque')
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
    console.error('Erro isolado na API de estoque:', err.message);
    res.status(500).json({ error: 'Erro ao buscar estoque', detalhe: err.message });
  }
});

// ROTA OUTBOUND (Isolada nas tabelas 'saida_porcentagem' e 'itens')
app.get('/api/outbound', async (req, res) => {
  try {
    const kpiQuery = `
      SELECT 
        SUM(qtde_integrada) AS total_pecas_integradas,
        SUM(qtd_nf_integrada) AS total_pedidos_integrados,
        SUM(qtde_produzida) AS total_pecas_produzidas,
        SUM(qtd_nf_produzida) AS total_pedidos_produzidos,
        MAX(integrado_x_forecast_) AS integrado_x_forecast,
        MAX(produzido_x_forecast_) AS produzido_x_forecast,
        MAX(_sla) AS sla_porcentagem
      FROM saida_porcentagem;
    `;

    const statusQuery = `
      SELECT 
        COUNT(DISTINCT pedido_de_venda) FILTER (WHERE status_operacional ILIKE '%Fluxo%') AS ped_fluxo,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Fluxo%') AS pecas_fluxo,
        
        COUNT(DISTINCT pedido_de_venda) FILTER (WHERE status_operacional ILIKE '%Coleta%') AS ped_coleta,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Coleta%') AS pecas_coleta,
        
        COUNT(DISTINCT pedido_de_venda) FILTER (WHERE status_operacional ILIKE '%Tratativa%') AS ped_tratativa,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Tratativa%') AS pecas_tratativa,
        
        COUNT(DISTINCT pedido_de_venda) FILTER (WHERE status_operacional ILIKE '%Expedid%') AS ped_expedidas,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Expedid%') AS pecas_expedidas
      FROM itens;
    `;

    const integradasDataQuery = `
      SELECT importado_data AS data, SUM(quantidade) AS total
      FROM itens WHERE importado_data IS NOT NULL GROUP BY importado_data ORDER BY importado_data ASC;
    `;

    const faturadosDataQuery = `
      SELECT faturado_data AS data, SUM(quantidade) AS quantidade, COUNT(DISTINCT nota_fiscal) AS nota_fiscal
      FROM itens WHERE faturado_data IS NOT NULL GROUP BY faturado_data ORDER BY faturado_data ASC;
    `;

    const expedidasDataQuery = `
      SELECT coletado_data AS data, SUM(quantidade) AS total
      FROM itens WHERE coletado_data IS NOT NULL GROUP BY coletado_data ORDER BY coletado_data ASC;
    `;

    const statusPorDataQuery = `
      SELECT 
        importado_data AS data,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Expedid%') AS expedido,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Fluxo%') AS em_fluxo,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Ag%') AS ag_exp
      FROM itens WHERE importado_data IS NOT NULL GROUP BY importado_data ORDER BY importado_data DESC;
    `;

    const [kpis, status, integradas, faturados, expedidas, statusData] = await Promise.all([
      pool.query(kpiQuery).catch(() => ({ rows: [] })),
      pool.query(statusQuery).catch(() => ({ rows: [] })),
      pool.query(integradasDataQuery).catch(() => ({ rows: [] })),
      pool.query(faturadosDataQuery).catch(() => ({ rows: [] })),
      pool.query(expedidasDataQuery).catch(() => ({ rows: [] })),
      pool.query(statusPorDataQuery).catch(() => ({ rows: [] }))
    ]);

    res.json({
      sla: kpis.rows[0]?.sla_porcentagem || '0,00%',
      pct_integrado_fcst: kpis.rows[0]?.integrado_x_forecast || '0,00%',
      pct_produzido_fcst: kpis.rows[0]?.produzido_x_forecast || '0,00%',
      integradas: { pecas: kpis.rows[0]?.total_pecas_integradas || 0, pedidos: kpis.rows[0]?.total_pedidos_integrados || 0 },
      produzidas: { pecas: kpis.rows[0]?.total_pecas_produzidas || 0, pedidos: kpis.rows[0]?.total_pedidos_produzidos || 0 },
      fluxo: { pecas: status.rows[0]?.pecas_fluxo || 0, pedidos: status.rows[0]?.ped_fluxo || 0 },
      coleta: { pecas: status.rows[0]?.pecas_coleta || 0, pedidos: status.rows[0]?.ped_coleta || 0 },
      tratativa: { pecas: status.rows[0]?.pecas_tratativa || 0, pedidos: status.rows[0]?.ped_tratativa || 0 },
      expedidas: { pecas: status.rows[0]?.pecas_expedidas || 0, pedidos: status.rows[0]?.ped_expedidas || 0 },
      graficos: {
        integradas_por_data: integradas.rows,
        faturados_por_data: faturados.rows,
        expedidas_por_data: expedidas.rows,
        status_por_data: statusData.rows
      }
    });

  } catch (err) {
    console.error('Erro na rota /api/outbound:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor no Outbound' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});