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

// ===== FORECAST DIÁRIO (dias úteis = segunda a sábado, sem feriados) =====
// Feriados nacionais fixos (MM-DD). Sexta-feira Santa é calculada pela data da Páscoa.
const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
// Para incluir feriados estaduais/municipais ou dias sem operação, adicione aqui no formato 'AAAA-MM-DD'
const FERIADOS_EXTRAS = [];

function isoUTC(d) {
  return d.toISOString().slice(0, 10);
}

function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const cacheFeriados = {};
function feriadosDoAno(ano) {
  if (cacheFeriados[ano]) return cacheFeriados[ano];
  const set = new Set(FERIADOS_FIXOS.map(md => `${ano}-${md}`));
  const sextaSanta = new Date(pascoa(ano).getTime() - 2 * 86400000);
  set.add(isoUTC(sextaSanta));
  FERIADOS_EXTRAS.forEach(d => set.add(d));
  cacheFeriados[ano] = set;
  return set;
}

function ehDiaUtil(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCDay() === 0) return false; // domingo não conta
  return !feriadosDoAno(a).has(iso);
}

function diasUteisDoMes(ano, mes) {
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= ultimo; d++) {
    const iso = `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (ehDiaUtil(iso)) n++;
  }
  return n;
}

function diasDoPeriodo(isoIni, isoFim) {
  const [a1, m1, d1] = isoIni.split('-').map(Number);
  const [a2, m2, d2] = isoFim.split('-').map(Number);
  const fim = Date.UTC(a2, m2 - 1, d2);
  const dias = [];
  for (let t = Date.UTC(a1, m1 - 1, d1); t <= fim; t += 86400000) {
    dias.push(isoUTC(new Date(t)));
  }
  return dias;
}

// ===== CANAIS (aba por canal) =====
// re = padrão para casar o valor da coluna "canal" / "modalidade"; col = coluna do forecast_outbound
const MAPA_CANAL = {
  b2b:           { re: '^b2b',        col: 'b2b_total' },
  b2c:           { re: '^b2c',        col: 'b2c_total' },
  transferencia: { re: '^transfer',   col: 'transferencias_total' },
  prefeitura:    { re: '^prefeitura', col: 'prefeitura_total' }
};

// ROUTE 2: OUTBOUND GERAL (filtro opcional ?canal=b2b|b2c|transferencia|prefeitura)
app.get('/api/outbound', async (req, res) => {
  const canalKey = String(req.query.canal || '').toLowerCase();
  const cfgCanal = MAPA_CANAL[canalKey] || null;
  const canalRe = cfgCanal ? cfgCanal.re : '';
  const chaveOutbound = `outbound:${canalKey || 'geral'}:${req.query.data_inicio || 'mes'}:${req.query.data_fim || 'atual'}`;
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
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
    `, [dtInicio, dtFim, canalRe]);

    const kpisProduzidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_produzidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_produzidos
      FROM "itens"
      WHERE "conferido_em"::timestamp >= $1::timestamp 
        AND "conferido_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
    `, [dtInicio, dtFim, canalRe]);

    const kpisExpedidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_expedidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_expedidos
      FROM "itens"
      WHERE "processado_em"::timestamp >= $1::timestamp 
        AND "processado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
    `, [dtInicio, dtFim, canalRe]);

    const graficoIntegradas = await pool.query(`
      SELECT 
        DATE("importado_em") AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE "importado_em"::timestamp >= $1::timestamp 
        AND "importado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
      GROUP BY DATE("importado_em")
      ORDER BY DATE("importado_em") ASC
    `, [dtInicio, dtFim, canalRe]);

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
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
      GROUP BY DATE("conferido_em"::timestamp)
      ORDER BY DATE("conferido_em"::timestamp) ASC
    `, [dtInicio, dtFim, canalRe]);

    // 6. Gráfico: Peças Expedidas por Data (via processado_em)
    const graficoExpedidas = await pool.query(`
      SELECT 
        DATE("processado_em"::timestamp) AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE "processado_em"::timestamp >= $1::timestamp 
        AND "processado_em"::timestamp <= $2::timestamp
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        AND ($3::text = '' OR TRIM("canal"::text) ~* $3::text)
      GROUP BY DATE("processado_em"::timestamp)
      ORDER BY DATE("processado_em"::timestamp) ASC
    `, [dtInicio, dtFim, canalRe]);

    // 7. Forecast e % x Forecast (mês de referência = mês da data inicial do filtro, formato AAAAMM)
    const mesRef = dtInicio.slice(0, 4) + dtInicio.slice(5, 7);
    let forecastPecas = 0;
    const forecastDiario = [];
    let integVsFcst = '0,00%';
    let prodVsFcst = '0,00%';
    try {
      const fc = await pool.query(
        `SELECT COALESCE(SUM("${cfgCanal ? cfgCanal.col : 'total'}"), 0) AS forecast
           FROM "forecast_outbound"
          WHERE TRIM("mes") = $1`,
        [mesRef]
      );
      forecastPecas = Number(fc.rows[0]?.forecast || 0);

      // Forecast por dia útil (valor do mês ÷ dias úteis do mês), para todos os meses do período
      const dias = diasDoPeriodo(dtInicio.slice(0, 10), dtFim.slice(0, 10));
      const mesesPeriodo = [...new Set(dias.map(d => d.slice(0, 4) + d.slice(5, 7)))];
      const colForecast = cfgCanal ? cfgCanal.col : 'total';
      const fm = await pool.query(
        `SELECT TRIM("mes") AS mes, COALESCE(SUM("${colForecast}"), 0) AS valor
           FROM "forecast_outbound"
          WHERE TRIM("mes") = ANY($1::text[])
          GROUP BY TRIM("mes")`,
        [mesesPeriodo]
      );
      const totalPorMes = {};
      fm.rows.forEach(r => { totalPorMes[r.mes] = Number(r.valor || 0); });

      dias.forEach(iso => {
        if (!ehDiaUtil(iso)) return;
        const mesKey = iso.slice(0, 4) + iso.slice(5, 7);
        const total = totalPorMes[mesKey] || 0;
        if (total <= 0) return;
        const uteis = diasUteisDoMes(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
        forecastDiario.push({ data: iso, valor: Math.round(total / uteis) });
      });

      const pct = await pool.query(
        `SELECT "integrado_x_forecast_" AS integrado, "produzido_x_forecast_" AS produzido
           FROM "saida_porcentagem"
          WHERE ${cfgCanal ? 'TRIM("modalidade") ~* $2' : `UPPER(TRIM("modalidade")) = 'TOTAL'`}
            AND LEFT(TRIM("data"), 6) = $1
          LIMIT 1`,
        cfgCanal ? [mesRef, cfgCanal.re] : [mesRef]
      );
      if (pct.rows[0]) {
        integVsFcst = (pct.rows[0].integrado || '0,00%').trim();
        prodVsFcst = (pct.rows[0].produzido || '0,00%').trim();
      }
    } catch (e) {
      console.error('Aviso: erro ao buscar forecast:', e.message);
    }

    const imp = kpisImportados.rows[0] || {};
    const prod = kpisProduzidos.rows[0] || {};
    const exp = kpisExpedidos.rows[0] || {};

    const resposta = {
      forecast_pecas: forecastPecas,
      forecast_diario: forecastDiario,
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
      integrado_vs_fcst: integVsFcst,
      produzido_vs_fcst: prodVsFcst,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    };

    await responderComCache(res, chaveOutbound, resposta,
      d => d.pecas_integradas === 0 && d.pecas_produzidas === 0 && d.pecas_expedidas === 0);
  } catch (err) {
    await erroComCache(res, chaveOutbound, err, 'Erro no Outbound');
  }
});

// ROUTE 3: RESUMO DE NF (todos os status)
// Qtde de SKUs: o valor se repete em todas as linhas da nota, então pegamos 1 por nota (MAX), sem somar.
app.get('/api/notas-fluxo', async (req, res) => {
  try {
    const base = `
      WITH base AS (
        SELECT
          "nota_fiscal"::text AS nota_fiscal,
          COALESCE(NULLIF(TRIM("status_operacional"), ''), 'SEM STATUS') AS status,
          MAX("canal") AS canal,
          MAX("destinatario") AS destinatario,
          MAX(CASE WHEN TRIM("qtde_de_produto"::text) ~ '^[0-9]+([.,][0-9]+)?$'
                   THEN REPLACE(TRIM("qtde_de_produto"::text), ',', '.')::numeric END) AS skus,
          COALESCE(SUM("quantidade"), 0) AS pecas,
          COUNT(DISTINCT "pedido_de_venda") AS pedidos
        FROM "itens"
        WHERE "nota_fiscal" IS NOT NULL
          AND TRIM("nota_fiscal"::text) <> ''
        GROUP BY "nota_fiscal"::text,
                 COALESCE(NULLIF(TRIM("status_operacional"), ''), 'SEM STATUS')
      ),
      nf AS (
        SELECT
          nota_fiscal,
          MAX(canal) AS canal,
          MAX(destinatario) AS destinatario,
          MAX(skus) AS skus,
          SUM(pecas) AS pecas
        FROM base
        GROUP BY nota_fiscal
      )
    `;

    const notas = await pool.query(`
      ${base}
      SELECT nota_fiscal, status, canal, destinatario, skus, pedidos, pecas
      FROM base
      ORDER BY nota_fiscal DESC
      LIMIT 5000
    `);

    const porStatus = await pool.query(`
      ${base}
      SELECT
        status,
        COUNT(DISTINCT nota_fiscal) AS notas,
        COALESCE(SUM(skus), 0) AS skus,
        COALESCE(SUM(pecas), 0) AS pecas
      FROM base
      GROUP BY status
      ORDER BY notas DESC
    `);

    const porCanal = await pool.query(`
      ${base}
      SELECT
        COALESCE(NULLIF(TRIM(canal), ''), 'SEM CANAL') AS canal,
        COUNT(*) AS notas,
        COALESCE(SUM(skus), 0) AS skus,
        COALESCE(SUM(pecas), 0) AS pecas
      FROM nf
      GROUP BY 1
      ORDER BY notas DESC
    `);

    const totais = await pool.query(`
      ${base}
      SELECT
        COUNT(*) AS total_notas,
        COALESCE(SUM(skus), 0) AS total_skus,
        COALESCE(SUM(pecas), 0) AS total_pecas
      FROM nf
    `);

    const resposta = {
      total_notas: Number(totais.rows[0]?.total_notas || 0),
      total_skus: Number(totais.rows[0]?.total_skus || 0),
      total_pecas: Number(totais.rows[0]?.total_pecas || 0),
      por_status: porStatus.rows,
      por_canal: porCanal.rows,
      notas: notas.rows,
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    };

    await responderComCache(res, 'resumo-nf', resposta, d => d.total_notas === 0);
  } catch (err) {
    await erroComCache(res, 'resumo-nf', err, 'Erro Resumo NF');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});