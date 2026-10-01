const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração da conexão com o Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Servir arquivos estáticos (HTML, CSS, JS) da pasta "public"
app.use(express.static('public'));
app.use(express.json());

// ROTA 1: Estoque (Aba Estoque)
app.get('/api/estoque', async (req, res) => {
  try {
    // Exemplo de busca de dados de estoque se houver tabela própria
    res.json({ status: 'ok', mensagem: 'Dados de estoque' });
  } catch (err) {
    console.error('Erro na API /api/estoque:', err);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// ROTA 2: Outbound - Geral (Nova Aba)
app.get('/api/outbound', async (req, res) => {
  try {
    // 1. KPIs da tabela "saida_porcentagem"
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

    // 2. Status operacionais da tabela "itens"
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

    // 3. Gráfico Peças Integradas por Data
    const integradasDataQuery = `
      SELECT importado_data AS data, SUM(quantidade) AS total
      FROM itens
      WHERE importado_data IS NOT NULL
      GROUP BY importado_data
      ORDER BY importado_data ASC;
    `;

    // 4. Gráfico Faturados por Data
    const faturadosDataQuery = `
      SELECT faturado_data AS data, SUM(quantidade) AS quantidade, COUNT(DISTINCT nota_fiscal) AS nota_fiscal
      FROM itens
      WHERE faturado_data IS NOT NULL
      GROUP BY faturado_data
      ORDER BY faturado_data ASC;
    `;

    // 5. Gráfico Expedidas por Data
    const expedidasDataQuery = `
      SELECT coletado_data AS data, SUM(quantidade) AS total
      FROM itens
      WHERE coletado_data IS NOT NULL
      GROUP BY coletado_data
      ORDER BY coletado_data ASC;
    `;

    // 6. Gráfico Lateral (Status por Data)
    const statusPorDataQuery = `
      SELECT 
        importado_data AS data,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Expedid%') AS expedido,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Fluxo%') AS em_fluxo,
        SUM(quantidade) FILTER (WHERE status_operacional ILIKE '%Ag%') AS ag_exp
      FROM itens
      WHERE importado_data IS NOT NULL
      GROUP BY importado_data
      ORDER BY importado_data DESC;
    `;

    // Executa as consultas em paralelo para alta performance
    const [kpis, status, integradas, faturados, expedidas, statusData] = await Promise.all([
      pool.query(kpiQuery),
      pool.query(statusQuery),
      pool.query(integradasDataQuery),
      pool.query(faturadosDataQuery),
      pool.query(expedidasDataQuery),
      pool.query(statusPorDataQuery)
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
    console.error('Erro na rota /api/outbound:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Inicia o servidor Node
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}: http://localhost:${port}`);
});