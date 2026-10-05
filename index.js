const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONEXÃO COM O NEON =====
// A string de conexão deve estar na variável de ambiente DATABASE_URL (Render > Environment)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


// ===== CACHE DO ÚLTIMO RESULTADO BOM =====
// Quando o banco está sendo recarregado (tabela vazia), o site continua mostrando
// o último resultado válido. Guarda na memória e numa tabela própria "dashboard_cache"
// (não mexe nas suas tabelas), para sobreviver a reinícios do Render.
const memoria = {};

async function iniciarCache() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_cache (
        chave TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        atualizado_em TEXT NOT NULL
      )
    `);
  } catch (e) {
    console.error('Aviso: não foi possível criar a tabela de cache:', e.message);
  }
}
iniciarCache();

async function salvarCache(chave, resposta) {
  const hora = new Date().toLocaleString('pt-BR');
  memoria[chave] = { resposta, hora };
  try {
    await pool.query(
      `INSERT INTO dashboard_cache (chave, payload, atualizado_em) VALUES ($1, $2, $3)
       ON CONFLICT (chave) DO UPDATE SET payload = EXCLUDED.payload, atualizado_em = EXCLUDED.atualizado_em`,
      [chave, JSON.stringify(resposta), hora]
    );
  } catch (e) {
    console.error('Aviso: não foi possível salvar o cache:', e.message);
  }
}

async function lerCache(chave) {
  if (memoria[chave]) return memoria[chave];
  try {
    const r = await pool.query('SELECT payload, atualizado_em FROM dashboard_cache WHERE chave = $1', [chave]);
    if (r.rows[0]) {
      const item = { resposta: r.rows[0].payload, hora: r.rows[0].atualizado_em };
      memoria[chave] = item;
      return item;
    }
  } catch (e) {}
  return null;
}

// Responde com dados novos; se vierem vazios, responde com o último resultado bom
async function responderComCache(res, chave, resposta, estaVazio) {
  if (!estaVazio(resposta)) {
    salvarCache(chave, resposta);
    return res.json(resposta);
  }
  const anterior = await lerCache(chave);
  if (anterior) {
    return res.json({ ...anterior.resposta, ultima_atualizacao: anterior.hora, dados_anteriores: true });
  }
  return res.json(resposta);
}

// Se a consulta falhar (ex.: durante a carga), tenta o último resultado bom
async function erroComCache(res, chave, err, titulo) {
  console.error(titulo + ':', err);
  const anterior = await lerCache(chave);
  if (anterior) {
    return res.json({ ...anterior.resposta, ultima_atualizacao: anterior.hora, dados_anteriores: true });
  }
  return res.status(500).json({ error: titulo, detalhe: err.message });
}

// ===== ARQUIVOS DO SITE =====
// Serve o index.html da pasta "public" se existir; senão, da raiz do projeto
const pastaSite = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

app.use(express.static(pastaSite));
app.get('/', (req, res) => res.sendFile(path.join(pastaSite, 'index.html')));

// ROUTE 1: ESTOQUE (TEMPORÁRIA)
// Devolve zeros até a gente refazer essa rota com as tabelas do estoque
app.get('/api/dashboard', async (req, res) => {
  res.json({
    picking: { total_pecas: 0, total_skus: 0, capacidade: 0, ocupadas: 0, vazias: 0 },
    pulmao:  { total_pecas: 0, total_skus: 0, capacidade: 0, ocupadas: 0, vazias: 0 },
    gerais:  { total_estoque: 0, total_skus: 0, total_posicoes: 0, posicoes_ocupadas: 0, posicoes_vazias: 0 },
    graficos: [],
    ultima_atualizacao: new Date().toLocaleString('pt-BR')
  });
});

// ROUTE 2: OUTBOUND GERAL
app.get('/api/outbound', async (req, res) => {
  const chaveOutbound = `outbound:${req.query.data_inicio || 'mes'}:${req.query.data_fim || 'atual'}`;
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

    const kpisImportados = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_integradas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_integrados,

        COALESCE(SUM(
          CASE WHEN "status_operacional" ILIKE '%importado%'
                 OR "status_operacional" ILIKE '%separa%'
                 OR "status_operacional" ILIKE '%onda%'
                 OR "status_operacional" ILIKE '%confer%'
               THEN "quantidade" ELSE 0 END
        ), 0) AS total_fluxo,

        COUNT(DISTINCT 
          CASE WHEN "status_operacional" ILIKE '%importado%'
                 OR "status_operacional" ILIKE '%separa%'
                 OR "status_operacional" ILIKE '%onda%'
                 OR "status_operacional" ILIKE '%confer%'
               THEN "pedido_de_venda" END
        ) AS pedidos_fluxo,

        COALESCE(SUM(
          CASE WHEN "status_operacional" ILIKE '%aguardando exped%'
               THEN "quantidade" ELSE 0 END
        ), 0) AS total_coleta,

        COUNT(DISTINCT 
          CASE WHEN "status_operacional" ILIKE '%aguardando exped%'
               THEN "pedido_de_venda" END
        ) AS pedidos_coleta,

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
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
    `, [dtInicio, dtFim]);

    const kpisProduzidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_produzidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_produzidos
      FROM "itens"
      WHERE "conferido_em"::timestamp >= $1::timestamp 
        AND "conferido_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
    `, [dtInicio, dtFim]);

    const kpisExpedidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_expedidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_expedidos
      FROM "itens"
      WHERE "processado_em"::timestamp >= $1::timestamp 
        AND "processado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
    `, [dtInicio, dtFim]);

    const graficoIntegradas = await pool.query(`
      SELECT 
        DATE("importado_em") AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE "importado_em"::timestamp >= $1::timestamp 
        AND "importado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
      GROUP BY DATE("importado_em")
      ORDER BY DATE("importado_em") ASC
    `, [dtInicio, dtFim]);

    // 5. Gráfico: Peças e Notas Faturadas por Data (via conferido_em)
    const graficoFaturados = await pool.query(`
      SELECT 
        DATE("conferido_em"::timestamp) AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas,
        COUNT(DISTINCT "nota_fiscal") AS total_notas
      FROM "itens"
      WHERE "conferido_em"::timestamp >= $1::timestamp 
        AND "conferido_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
      GROUP BY DATE("conferido_em"::timestamp)
      ORDER BY DATE("conferido_em"::timestamp) ASC
    `, [dtInicio, dtFim]);

    // 6. Gráfico: Peças Expedidas por Data (via processado_em)
    const graficoExpedidas = await pool.query(`
      SELECT 
        DATE("processado_em"::timestamp) AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE "processado_em"::timestamp >= $1::timestamp 
        AND "processado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
      GROUP BY DATE("processado_em"::timestamp)
      ORDER BY DATE("processado_em"::timestamp) ASC
    `, [dtInicio, dtFim]);

    const imp = kpisImportados.rows[0] || {};
    const prod = kpisProduzidos.rows[0] || {};
    const exp = kpisExpedidos.rows[0] || {};

    const resposta = {
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
      pecas_faturadas_grafico: graficoFaturados.rows || [],
      pecas_expedidas_grafico: graficoExpedidas.rows || [],
      sla_pct: '100,00%',
      integrado_vs_fcst: '0,00%',
      produzido_vs_fcst: '0,00%',
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    };

    await responderComCache(res, chaveOutbound, resposta,
      d => d.pecas_integradas === 0 && d.pecas_produzidas === 0 && d.pecas_expedidas === 0);
  } catch (err) {
    await erroComCache(res, chaveOutbound, err, 'Erro no Outbound');
  }
});

// ROUTE 3: NOTAS EM FLUXO
// Exclui: Expedido, Cancelado, Aguardando expedição
app.get('/api/notas-fluxo', async (req, res) => {
  try {
    const filtroStatus = `
      "nota_fiscal" IS NOT NULL
      AND TRIM("nota_fiscal"::text) <> ''
      AND COALESCE("status_operacional", '') NOT ILIKE ALL (
        ARRAY['%expedido%', '%cancelado%', '%aguardando exped%']
      )
    `;

    const notas = await pool.query(`
      SELECT
        "nota_fiscal" AS nota_fiscal,
        COALESCE("status_operacional", 'SEM STATUS') AS status,
        COALESCE(SUM("quantidade"), 0) AS pecas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos
      FROM "itens"
      WHERE ${filtroStatus}
      GROUP BY "nota_fiscal", COALESCE("status_operacional", 'SEM STATUS')
      ORDER BY "nota_fiscal" DESC
      LIMIT 2000
    `);

    const porStatus = await pool.query(`
      SELECT
        COALESCE("status_operacional", 'SEM STATUS') AS status,
        COUNT(DISTINCT "nota_fiscal") AS notas,
        COALESCE(SUM("quantidade"), 0) AS pecas
      FROM "itens"
      WHERE ${filtroStatus}
      GROUP BY COALESCE("status_operacional", 'SEM STATUS')
      ORDER BY notas DESC
    `);

    const totais = await pool.query(`
      SELECT
        COUNT(DISTINCT "nota_fiscal") AS total_notas,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE ${filtroStatus}
    `);

    const resposta = {
      total_notas: Number(totais.rows[0]?.total_notas || 0),
      total_pecas: Number(totais.rows[0]?.total_pecas || 0),
      por_status: porStatus.rows,
      notas: notas.rows,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    };

    await responderComCache(res, 'notas-fluxo', resposta, d => d.total_notas === 0);
  } catch (err) {
    await erroComCache(res, 'notas-fluxo', err, 'Erro Notas Fluxo');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});