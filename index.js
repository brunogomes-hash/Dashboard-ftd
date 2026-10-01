// ROUTE 2: OUTBOUND GERAL (COM FLUXO, COLETA E TRATATIVA CORRIGIDOS)
app.get('/api/outbound', async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;

    let dtInicio, dtFim;
    if (data_inicio && data_fim) {
      dtInicio = `${data_inicio} 00:00:00`;
      dtFim = `${data_fim} 23:59:59`;
    } else {
      const hoje = new Date();
      const ano = hoje.getFullYear();
      const mes = String(hoje.getMonth() + 1).padStart(2, '0');
      const ultimoDia = new Date(ano, hoje.getMonth() + 1, 0).getDate();
      dtInicio = `${ano}-${mes}-01 00:00:00`;
      dtFim = `${ano}-${mes}-${String(ultimoDia).padStart(2, '0')} 23:59:59`;
    }

    // 1. Integradas, Em Fluxo, Em Coleta e Em Tratativa
    const kpisImportados = await pool.query(`
      SELECT 
        -- Total Integradas
        COALESCE(SUM("quantidade"), 0) AS total_integradas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_integrados,

        -- Em Fluxo (Importado, Separação, Onda, Conferência)
        COALESCE(SUM(
          CASE WHEN "status_operacional" ILIKE '%importado%'
                 OR "status_operacional" ILIKE '%separa%'
                 OR "status_operacional" ILIKE '%onda%'
                 OR "status_operacional" ILIKE '%confer% '
                 OR "status_operacional" ILIKE '%em conferência%'
               THEN "quantidade" ELSE 0 END
        ), 0) AS total_fluxo,

        COUNT(DISTINCT 
          CASE WHEN "status_operacional" ILIKE '%importado%'
                 OR "status_operacional" ILIKE '%separa%'
                 OR "status_operacional" ILIKE '%onda%'
                 OR "status_operacional" ILIKE '%confer%'
               THEN "pedido_de_venda" END
        ) AS pedidos_fluxo,

        -- Em Coleta (Aguardando Coleta / Coletando / Pronto para Expedir)
        COALESCE(SUM(
          CASE WHEN "status_operacional" ILIKE '%coleta%' 
                 OR "status_operacional" ILIKE '%expedi%'
               THEN "quantidade" ELSE 0 END
        ), 0) AS total_coleta,

        COUNT(DISTINCT 
          CASE WHEN "status_operacional" ILIKE '%coleta%' 
                 OR "status_operacional" ILIKE '%expedi%'
               THEN "pedido_de_venda" END
        ) AS pedidos_coleta,

        -- Em Tratativa (Retenção)
        COALESCE(SUM(
          CASE WHEN "status_da_nota_fiscal" ILIKE '%RETEN%'
                 OR "status_operacional" ILIKE '%RETEN%'
                 OR "status_operacional" ILIKE '%TRATATIVA%'
               THEN "quantidade" ELSE 0 END
        ), 0) AS total_tratativa,

        COUNT(DISTINCT 
          CASE WHEN "status_da_nota_fiscal" ILIKE '%RETEN%'
                 OR "status_operacional" ILIKE '%RETEN%'
                 OR "status_operacional" ILIKE '%TRATATIVA%'
               THEN "pedido_de_venda" END
        ) AS pedidos_tratativa

      FROM "itens"
      WHERE "importado_em"::timestamp >= $1::timestamp 
        AND "importado_em"::timestamp <= $2::timestamp
    `, [dtInicio, dtFim]);

    // 2. Produzidas (via conferido_em)
    const kpisProduzidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_produzidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_produzidos
      FROM "itens"
      WHERE "conferido_em"::timestamp >= $1::timestamp 
        AND "conferido_em"::timestamp <= $2::timestamp
    `, [dtInicio, dtFim]);

    // 3. Expedidas (via pesado_em)
    const kpisExpedidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_expedidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_expedidos
      FROM "itens"
      WHERE "pesado_em"::timestamp >= $1::timestamp 
        AND "pesado_em"::timestamp <= $2::timestamp
    `, [dtInicio, dtFim]);

    // 4. Gráfico de Peças Integradas por Data
    const graficoIntegradas = await pool.query(`
      SELECT 
        DATE("importado_em") AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE "importado_em"::timestamp >= $1::timestamp 
        AND "importado_em"::timestamp <= $2::timestamp
      GROUP BY DATE("importado_em")
      ORDER BY DATE("importado_em") ASC
    `, [dtInicio, dtFim]);

    const imp = kpisImportados.rows[0] || {};
    const prod = kpisProduzidos.rows[0] || {};
    const exp = kpisExpedidos.rows[0] || {};

    res.json({
      forecast_pecas: 0,
      pecas_integradas: Number(imp.total_integradas || 0),
      pedidos_integradas: Number(imp.pedidos_integrados || 0),

      pecas_fluxo: Number(imp.total_fluxo || 0),
      pedidos_fluxo: Number(imp.pedidos_fluxo || 0),

      em_coleta: Number(imp.total_coleta || 0),
      pedidos_coleta: Number(imp.pedidos_coleta || 0),

      em_tratativa: Number(imp.total_tratativa || 0),
      pedidos_tratativa: Number(imp.pedidos_tratativa || 0),

      pecas_produzidas: Number(prod.total_produzidas || 0),
      pedidos_produzidas: Number(prod.pedidos_produzidos || 0),

      pecas_expedidas: Number(exp.total_expedidas || 0),
      pedidos_expedidas: Number(exp.pedidos_expedidos || 0),

      pecas_integradas_grafico: graficoIntegradas.rows || [],
      sla_pct: '100,00%',
      integrado_vs_fcst: '0,00%',
      produzido_vs_fcst: '0,00%',
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro no Outbound:', err);
    res.status(500).json({ error: 'Erro no Outbound', detalhe: err.message });
  }
});