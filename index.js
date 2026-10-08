const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONEXÃO COM O DATABASE (URL do Supabase ou Neon) =====
function urlSemSsl(url) {
  try {
    const u = new URL(url);
    ['sslmode', 'sslrootcert', 'sslkey', 'uselibpqcompat'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch (e) {
    return url;
  }
}

const pool = new Pool({
  connectionString: urlSemSsl(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false }
});
pool.on('error', e => console.error('Erro no pool do banco:', e.message));

// ===== NUNCA DEIXAR O NAVEGADOR/PROXY GUARDAR RESPOSTA DA API =====
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ===== ÚLTIMA ATUALIZAÇÃO =====
const FUSO = 'America/Sao_Paulo';
const agoraBR = () => new Date().toLocaleString('pt-BR', { timeZone: FUSO });

function lerAtualizacao(txt) {
  const t = String(txt || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  return null;
}

let atualizacaoCache = { valor: null, em: 0 };
async function ultimaAtualizacao() {
  if (atualizacaoCache.valor && Date.now() - atualizacaoCache.em < 30000) return atualizacaoCache.valor;
  atualizacaoCache.em = Date.now();
  try {
    const r = await pool.query(`
      SELECT DISTINCT TRIM("última_atualização") AS v
      FROM "entrada_consolidada"
      WHERE "última_atualização" IS NOT NULL AND TRIM("última_atualização") <> ''
      LIMIT 500`);
    let melhor = null, melhorT = -1;
    r.rows.forEach(({ v }) => {
      const p = lerAtualizacao(v);
      if (p) {
        const t = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
        if (t > melhorT) { melhorT = t; melhor = p; }
      }
    });
    const dois = n => String(n).padStart(2, '0');
    if (melhor) {
      atualizacaoCache.valor = `${dois(melhor.d)}/${dois(melhor.mo)}/${melhor.y}, ${dois(melhor.h)}:${dois(melhor.mi)}:${dois(melhor.s)}`;
    } else if (r.rows[0]) {
      atualizacaoCache.valor = r.rows[0].v;
    }
  } catch (e) {
    console.error('Aviso: não foi possível ler a última atualização:', e.message);
  }
  return atualizacaoCache.valor || agoraBR();
}

// ===== CACHE DO ÚLTIMO RESULTADO BOM =====
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
  const hora = agoraBR();
  memoria[chave] = { resposta, hora, ts: Date.now() };
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

function comoAnterior(anterior, motivo, detalhe) {
  const extra = { dados_anteriores: true, cache_hora: anterior.hora, cache_motivo: motivo };
  if (detalhe) extra.cache_erro = detalhe;
  return { ...anterior.resposta, ...extra };
}

async function responderComCache(res, chave, resposta, estaVazio) {
  if (!estaVazio(resposta)) {
    salvarCache(chave, resposta);
    return res.json(resposta);
  }
  const anterior = await lerCache(chave);
  if (anterior) {
    console.warn(`[${chave}] resultado vazio -> servindo cache de ${anterior.hora}`);
    return res.json(comoAnterior(anterior, 'resultado_vazio'));
  }
  return res.json(resposta);
}

async function erroComCache(res, chave, err, titulo) {
  console.error(`[${chave}] ${titulo}:`, err);
  const anterior = await lerCache(chave);
  if (anterior) {
    return res.json(comoAnterior(anterior, 'erro_na_consulta', err.message));
  }
  return res.status(500).json({ error: titulo, detalhe: err.message });
}

// ===== DETECTOR DE RECARGA DO BANCO =====
const contagensTabela = {};
const encolhidaDesde = {};
const LIMITE_ENCOLHEU = 0.5;
const MAX_RECARGA_MS = 10 * 60 * 1000;

async function tabelaEmRecarga(tabela) {
  try {
    const nome = '"' + String(tabela).replace(/"/g, '""') + '"';
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${nome}`);
    const n = r.rows[0].n;
    const antes = contagensTabela[tabela] || 0;
    const encolheu = n === 0 || (antes > 0 && n < antes * LIMITE_ENCOLHEU);

    if (encolheu) {
      if (n > 0) {
        const desde = encolhidaDesde[tabela] || (encolhidaDesde[tabela] = Date.now());
        if (Date.now() - desde > MAX_RECARGA_MS) {
          contagensTabela[tabela] = n;
          delete encolhidaDesde[tabela];
          return false;
        }
      }
      return true;
    }

    delete encolhidaDesde[tabela];
    contagensTabela[tabela] = n;
    return false;
  } catch (e) {
    console.error(`Aviso: não foi possível contar "${tabela}":`, e.message);
    return false;
  }
}

async function servirCacheSeRecarga(res, chave, tabelas) {
  for (const t of tabelas) {
    if (await tabelaEmRecarga(t)) {
      const anterior = await lerCache(chave);
      if (anterior) {
        console.warn(`[${chave}] tabela "${t}" em recarga -> servindo cache de ${anterior.hora}`);
        res.json(comoAnterior(anterior, 'tabela_em_recarga:' + t));
        return true;
      }
      return false;
    }
  }
  return false;
}

// ===== ARQUIVOS DO SITE =====
const pastaSite = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

app.use(express.static(pastaSite));
app.get('/', (req, res) => res.sendFile(path.join(pastaSite, 'index.html')));

app.get('/api/status-cache', (req, res) => {
  res.json({
    agora: agoraBR(),
    cache_em_memoria: Object.fromEntries(Object.entries(memoria).map(([k, v]) => [k, v.hora])),
    contagens_tabelas: contagensTabela,
    encolhida_desde: Object.fromEntries(Object.entries(encolhidaDesde).map(([k, v]) => [k, new Date(v).toISOString()]))
  });
});

// ===== HELPERS E DETECÇÃO DE COLUNAS =====
const normNome = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const aspas = nome => '"' + String(nome).replace(/"/g, '""') + '"';
const BLOCOS_ESTOQUE = ['PP', 'PR', 'PQ', 'SP'];

let infoEstoque = null;
let infoEstoqueEm = 0;

async function detectarColunasEstoque() {
  const completo = infoEstoque && infoEstoque.colSku && infoEstoque.colQtd && infoEstoque.colCategoria;
  if (infoEstoque && (completo || Date.now() - infoEstoqueEm < 5 * 60 * 1000)) return infoEstoque;

  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'estoque'
      ORDER BY ordinal_position`
  );
  const colunas = r.rows.map(x => x.column_name);
  const achar = fn => colunas.find(c => fn(normNome(c)));

  const colSku = achar(n => n === 'codigo_do_produto') || achar(n => n.includes('codigo') && n.includes('produto'));
  const colQtd = achar(n => n === 'estoque') || achar(n => n === 'quantidade');
  const colEstado = achar(n => n === 'estado');
  const colArea = achar(n => n === 'area');

  const prioridade = ['categoria_estrutura', 'categoria', 'estrutura', 'tipo_estrutura', 'tipo_endereco', 'area', 'zona'];
  const candidatas = [...new Set([
    ...prioridade.map(p => colunas.find(c => normNome(c) === p)).filter(Boolean),
    ...colunas.filter(c => /categoria|estrutura|endereco|local|area|zona/.test(normNome(c)))
  ])].slice(0, 8);

  let colCategoria = null;
  for (const c of candidatas) {
    try {
      const t = await pool.query(`SELECT 1 FROM "estoque" WHERE ${aspas(c)}::text ILIKE '%pulm%' LIMIT 1`);
      if (t.rows.length) { colCategoria = c; break; }
    } catch (e) {}
  }

  infoEstoque = { colunas, colSku, colQtd, colCategoria, colEstado, colArea };
  infoEstoqueEm = Date.now();
  return infoEstoque;
}

// ROUTE 1: ESTOQUE
app.get('/api/dashboard', async (req, res) => {
  try {
    if (await servirCacheSeRecarga(res, 'estoque', ['estoque', 'capacidade_armazem'])) return;

    const cap = await pool.query(`
      SELECT
        TRIM("categoria_estrutura") AS categoria,
        COALESCE(SUM("locais_capacidade_qtd"), 0)          AS posicoes_capacidade,
        COALESCE(SUM("locais_ocupados_qtd"), 0)            AS posicoes_ocupadas,
        COALESCE(SUM("locais_livres_qtd"), 0)              AS posicoes_livres,
        COALESCE(SUM("capacidade_total_unidades"), 0)      AS pecas_capacidade,
        COALESCE(SUM("ocupados_unidades_disponiveis"), 0)  AS pecas_ocupadas,
        COALESCE(SUM("livres_unidades"), 0)                AS pecas_livres
      FROM "capacidade_armazem"
      WHERE "categoria_estrutura" IS NOT NULL
        AND TRIM("categoria_estrutura") <> ''
        AND TRIM("categoria_estrutura") NOT ILIKE 'total%'
      GROUP BY TRIM("categoria_estrutura")
      ORDER BY TRIM("categoria_estrutura")
    `);

    const linhas = cap.rows.map(r => ({
      categoria: r.categoria,
      posicoes_capacidade: Number(r.posicoes_capacidade),
      posicoes_ocupadas: Number(r.posicoes_ocupadas),
      posicoes_livres: Number(r.posicoes_livres),
      pecas_capacidade: Number(r.pecas_capacidade),
      pecas_ocupadas: Number(r.pecas_ocupadas),
      pecas_livres: Number(r.pecas_livres)
    }));
    const ehPulmao = l => normNome(l.categoria).includes('pulm');
    const pulmaoRows = linhas.filter(ehPulmao);
    const pickingRows = linhas.filter(l => !ehPulmao(l));
    const soma = (arr, campo) => arr.reduce((t, l) => t + l[campo], 0);

    let totalSkus = 0, totalPecas = 0;
    let skuPick = null, pecasPick = null, skuPul = null, pecasPul = null;
    let diag = {};
    let depositos = [];
    let foraSistema = [];

    try {
      const info = await detectarColunasEstoque();
      diag = { colunas_estoque: info.colunas, col_sku: info.colSku || null, col_qtd: info.colQtd || null, col_categoria: info.colCategoria || null, col_estado: info.colEstado || null, col_area: info.colArea || null };

      if (info.colSku && info.colQtd) {
        const qtd = `(CASE WHEN TRIM(${aspas(info.colQtd)}::text) ~ '^-?[0-9]+([.,][0-9]+)?$'
                          THEN REPLACE(TRIM(${aspas(info.colQtd)}::text), ',', '.')::numeric END)`;
        const filtroEstado = info.colEstado ? `WHERE UPPER(TRIM(${aspas(info.colEstado)}::text)) = 'NORMAL'` : '';
        const base = `
          SELECT TRIM(${aspas(info.colSku)}::text) AS sku, ${qtd} AS q
                 ${info.colCategoria ? `, (${aspas(info.colCategoria)}::text ILIKE '%pulm%') AS pulmao` : ''}
                 ${info.colArea ? `, COALESCE(NULLIF(TRIM(${aspas(info.colArea)}::text), ''), 'SEM ÁREA') AS area` : ''}
          FROM "estoque" ${filtroEstado}`;

        const soBlocos = info.colArea
          ? `WHERE UPPER(TRIM(t.area)) IN (${BLOCOS_ESTOQUE.map(b => `'${b}'`).join(', ')})`
          : '';

        const tot = await pool.query(`
          SELECT COUNT(DISTINCT sku) FILTER (WHERE q > 0 AND sku <> '') AS skus,
                 COALESCE(SUM(q) FILTER (WHERE q > 0), 0) AS pecas
          FROM (${base}) t ${soBlocos}`);
        totalSkus = Number(tot.rows[0]?.skus || 0);
        totalPecas = Number(tot.rows[0]?.pecas || 0);

        if (info.colCategoria) {
          const sp = await pool.query(`
            SELECT COALESCE(pulmao, false) AS pulmao,
                   COUNT(DISTINCT sku) FILTER (WHERE q > 0 AND sku <> '') AS skus,
                   COALESCE(SUM(q) FILTER (WHERE q > 0), 0) AS pecas
            FROM (${base}) t ${soBlocos}
            GROUP BY 1`);
          skuPick = 0; pecasPick = 0; skuPul = 0; pecasPul = 0;
          sp.rows.forEach(r => {
            if (r.pulmao) { skuPul = Number(r.skus); pecasPul = Number(r.pecas); }
            else { skuPick = Number(r.skus); pecasPick = Number(r.pecas); }
          });
        }

        if (info.colArea) {
          const dp = await pool.query(`
            SELECT area, COALESCE(SUM(q), 0) AS pecas
            FROM (${base}) t
            WHERE q > 0
            GROUP BY area
            ORDER BY pecas DESC
            LIMIT 12`);
          depositos = dp.rows.map(r => ({ area: r.area, pecas: Number(r.pecas) }));
        }
      }
    } catch (e) {
      diag = { erro_estoque: e.message };
    }

    try {
      const fs2 = await pool.query(`
        SELECT TRIM("status") AS status, COUNT(DISTINCT "local") AS qtd
        FROM "locais_ftd"
        WHERE UPPER(TRIM("ativo"::text)) = 'S'
          AND "status" IS NOT NULL
          AND TRIM("status") <> ''
        GROUP BY TRIM("status")
        ORDER BY qtd DESC
        LIMIT 10`);
      foraSistema = fs2.rows.map(r => ({ status: r.status, qtd: Number(r.qtd) }));
    } catch (e) {}

    const capPick = soma(pickingRows, 'posicoes_capacidade');
    const ocupPick = soma(pickingRows, 'posicoes_ocupadas');
    const vazPick = soma(pickingRows, 'posicoes_livres');
    const capPul = soma(pulmaoRows, 'posicoes_capacidade');
    const ocupPul = soma(pulmaoRows, 'posicoes_ocupadas');
    const vazPul = soma(pulmaoRows, 'posicoes_livres');

    const resposta = {
      picking: { total_pecas: pecasPick, total_skus: skuPick, capacidade: capPick, ocupadas: ocupPick, vazias: vazPick },
      pulmao:  { total_pecas: pecasPul,  total_skus: skuPul,  capacidade: capPul,  ocupadas: ocupPul,  vazias: vazPul },
      gerais: {
        total_estoque: totalPecas,
        total_skus: totalSkus,
        total_posicoes: capPick + capPul,
        posicoes_ocupadas: ocupPick + ocupPul,
        posicoes_vazias: vazPick + vazPul
      },
      graficos: linhas,
      graficos_picking: pickingRows,
      graficos_pulmao: pulmaoRows,
      fora_sistema: foraSistema,
      depositos: depositos,
      diagnostico: diag,
      ultima_atualizacao: await ultimaAtualizacao()
    };

    const anterior = await lerCache('estoque');
    if (anterior && anterior.resposta) {
      const a = anterior.resposta;
      let reaproveitou = false;

      const estoqueVazio = totalPecas === 0 && totalSkus === 0;
      if (estoqueVazio && a.gerais && a.gerais.total_estoque > 0) {
        resposta.gerais.total_estoque = a.gerais.total_estoque;
        resposta.gerais.total_skus = a.gerais.total_skus;
        ['picking', 'pulmao'].forEach(k => {
          if (a[k]) {
            resposta[k].total_pecas = a[k].total_pecas;
            resposta[k].total_skus = a[k].total_skus;
          }
        });
        if (!resposta.depositos.length && (a.depositos || []).length) resposta.depositos = a.depositos;
        reaproveitou = true;
      }

      if (!resposta.fora_sistema.length && (a.fora_sistema || []).length) {
        resposta.fora_sistema = a.fora_sistema;
        reaproveitou = true;
      }

      let capReaproveitada = false;
      if (!resposta.graficos_picking.length && (a.graficos_picking || []).length) {
        resposta.graficos_picking = a.graficos_picking;
        resposta.picking = { ...resposta.picking, capacidade: a.picking.capacidade, ocupadas: a.picking.ocupadas, vazias: a.picking.vazias };
        capReaproveitada = true;
      }
      if (!resposta.graficos_pulmao.length && (a.graficos_pulmao || []).length) {
        resposta.graficos_pulmao = a.graficos_pulmao;
        resposta.pulmao = { ...resposta.pulmao, capacidade: a.pulmao.capacidade, ocupadas: a.pulmao.ocupadas, vazias: a.pulmao.vazias };
        capReaproveitada = true;
      }
      if (capReaproveitada) {
        resposta.gerais.total_posicoes = resposta.picking.capacidade + resposta.pulmao.capacidade;
        resposta.gerais.posicoes_ocupadas = resposta.picking.ocupadas + resposta.pulmao.ocupadas;
        resposta.gerais.posicoes_vazias = resposta.picking.vazias + resposta.pulmao.vazias;
        reaproveitou = true;
      }

      if (reaproveitou) resposta.dados_parciais_anteriores = true;
    }

    await responderComCache(res, 'estoque', resposta,
      d => d.gerais.total_posicoes === 0 && d.gerais.total_estoque === 0);
  } catch (err) {
    await erroComCache(res, 'estoque', err, 'Erro Estoque');
  }
});

// ===== FORECAST DIÁRIO =====
const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
const FERIADOS_EXTRAS = [];

function isoUTC(d) { return d.toISOString().slice(0, 10); }

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
  if (dt.getUTCDay() === 0) return false;
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

// ===== MAPA DE CANAIS =====
const MAPA_CANAL = {
  b2b:           { re: 'b2b',          col: 'b2b_total' },
  b2c:           { re: 'b2c',          col: 'b2c_total' },
  transferencia: { re: 'transfer',     col: 'transferencias_total' },
  prefeitura:    { re: 'prefeitura',   col: 'prefeitura_total' }
};

function dia8(col) {
  return `SUBSTRING(TRIM("${col}"::text) FROM '^([0-9]{8})')`;
}
function dia8ISO(expr) {
  return `(SUBSTRING(${expr},1,4) || '-' || SUBSTRING(${expr},5,2) || '-' || SUBSTRING(${expr},7,2))`;
}

// ROUTE 2: OUTBOUND GERAL (E CANAIS INDIVIDUAIS)
app.get('/api/outbound', async (req, res) => {
  const canalKey = String(req.query.canal || '').toLowerCase().trim();
  const cfgCanal = MAPA_CANAL[canalKey] || null;
  const canalRe = cfgCanal ? cfgCanal.re : '';
  const chaveOutbound = `outbound:${canalKey || 'geral'}:${req.query.data_inicio || 'mes'}:${req.query.data_fim || 'atual'}`;

  const dImp = dia8('importado_data');
  const dConf = dia8('conferido_data');
  const dProc = dia8('processado_data');

  try {
    if (await servirCacheSeRecarga(res, chaveOutbound, ['itens'])) return;

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

    const dIni8 = dtInicio.slice(0, 10).replace(/-/g, '');
    const dFim8 = dtFim.slice(0, 10).replace(/-/g, '');

    let filtroCanal = '';
    if (canalRe) {
      const infoCanal = await detectarColunasItens();
      const temModalidade = infoCanal.colunas.some(c => normNome(c) === 'modalidade');
      filtroCanal = temModalidade
        ? `AND (TRIM("canal"::text) ILIKE '%${canalRe}%' OR TRIM(COALESCE("modalidade"::text, '')) ILIKE '%${canalRe}%')`
        : `AND TRIM("canal"::text) ILIKE '%${canalRe}%'`;
    }

    const kpisImportados = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_integradas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_integrados
      FROM "itens"
      WHERE ${dImp} >= $1::text 
        AND ${dImp} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
    `, [dIni8, dFim8]);

    const kpisStatus = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN "status_operacional" ILIKE '%importado%'
                            OR "status_operacional" ILIKE '%separa%'
                            OR "status_operacional" ILIKE '%onda%'
                            OR "status_operacional" ILIKE '%confer%'
                          THEN "quantidade" ELSE 0 END), 0) AS total_fluxo,
        COUNT(DISTINCT CASE WHEN "status_operacional" ILIKE '%importado%'
                            OR "status_operacional" ILIKE '%separa%'
                            OR "status_operacional" ILIKE '%onda%'
                            OR "status_operacional" ILIKE '%confer%'
                          THEN "pedido_de_venda" END) AS pedidos_fluxo,
        COALESCE(SUM(CASE WHEN "status_operacional" ILIKE '%aguardando exped%'
                          THEN "quantidade" ELSE 0 END), 0) AS total_coleta,
        COUNT(DISTINCT CASE WHEN "status_operacional" ILIKE '%aguardando exped%'
                          THEN "pedido_de_venda" END) AS pedidos_coleta,
        COALESCE(SUM(CASE WHEN "status_da_nota_fiscal" ILIKE '%RETEN%'
                            OR "status_operacional" ILIKE '%RETEN%'
                            OR "status_operacional" ILIKE '%TRATATIVA%'
                            OR "status_operacional" ILIKE '%corte%'
                          THEN "quantidade" ELSE 0 END), 0) AS total_tratativa,
        COUNT(DISTINCT CASE WHEN "status_da_nota_fiscal" ILIKE '%RETEN%'
                            OR "status_operacional" ILIKE '%RETEN%'
                            OR "status_operacional" ILIKE '%TRATATIVA%'
                            OR "status_operacional" ILIKE '%corte%'
                          THEN "pedido_de_venda" END) AS pedidos_tratativa
      FROM "itens"
      WHERE COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
    `);

    const kpisProduzidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_produzidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_produzidos
      FROM "itens"
      WHERE ${dConf} >= $1::text 
        AND ${dConf} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
    `, [dIni8, dFim8]);

    const kpisExpedidos = await pool.query(`
      SELECT 
        COALESCE(SUM("quantidade"), 0) AS total_expedidas,
        COUNT(DISTINCT "pedido_de_venda") AS pedidos_expedidos
      FROM "itens"
      WHERE ${dProc} >= $1::text 
        AND ${dProc} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
    `, [dIni8, dFim8]);

    const graficoIntegradas = await pool.query(`
      SELECT 
        ${dia8ISO(dImp)} AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE ${dImp} >= $1::text 
        AND ${dImp} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
      GROUP BY 1
      ORDER BY 1 ASC
    `, [dIni8, dFim8]);

    const graficoFaturados = await pool.query(`
      SELECT 
        ${dia8ISO(dConf)} AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas,
        COUNT(DISTINCT "nota_fiscal") AS total_notas
      FROM "itens"
      WHERE ${dConf} >= $1::text 
        AND ${dConf} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
      GROUP BY 1
      ORDER BY 1 ASC
    `, [dIni8, dFim8]);

    const graficoExpedidas = await pool.query(`
      SELECT 
        ${dia8ISO(dProc)} AS data,
        COALESCE(SUM("quantidade"), 0) AS total_pecas
      FROM "itens"
      WHERE ${dProc} >= $1::text 
        AND ${dProc} <= $2::text
        AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        ${filtroCanal}
      GROUP BY 1
      ORDER BY 1 ASC
    `, [dIni8, dFim8]);

    // ===== AJUSTE PRINCIPAL: Separação de Em Tratativa no Gráfico Lateral =====
    const graficoStatus = await pool.query(`
      SELECT
        t.data,
        COALESCE(SUM(CASE WHEN t.grupo = 'exp'       THEN t.q END), 0) AS expedido,
        COALESCE(SUM(CASE WHEN t.grupo = 'ag'        THEN t.q END), 0) AS ag_exp,
        COALESCE(SUM(CASE WHEN t.grupo = 'fluxo'     THEN t.q END), 0) AS em_fluxo,
        COALESCE(SUM(CASE WHEN t.grupo = 'tratativa' THEN t.q END), 0) AS em_tratativa
      FROM (
        SELECT
          ${dia8ISO(dImp)} AS data,
          "quantidade" AS q,
          CASE
            WHEN COALESCE("status_da_nota_fiscal", '') ILIKE '%RETEN%'
              OR COALESCE("status_operacional", '') ILIKE '%RETEN%'
              OR COALESCE("status_operacional", '') ILIKE '%TRATATIVA%'
              OR COALESCE("status_operacional", '') ILIKE '%corte%' THEN 'tratativa'
            WHEN COALESCE("status_operacional", '') ILIKE '%aguardando exped%' THEN 'ag'
            WHEN COALESCE("status_operacional", '') ILIKE '%expedido%' THEN 'exp'
            ELSE 'fluxo'
          END AS grupo
        FROM "itens"
        WHERE ${dImp} >= $1::text
          AND ${dImp} <= $2::text
          AND COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
          ${filtroCanal}
      ) t
      GROUP BY t.data
      ORDER BY t.data DESC
    `, [dIni8, dFim8]);

    const mesRef = dtInicio.slice(0, 4) + dtInicio.slice(5, 7);
    let forecastPecas = 0;
    const forecastDiario = [];
    let integVsFcst = '0,00%';
    let prodVsFcst = '0,00%';

    try {
      const colForecast = cfgCanal ? cfgCanal.col : 'total';
      const fc = await pool.query(
        `SELECT COALESCE(SUM("${colForecast}"), 0) AS forecast
           FROM "forecast_outbound"
          WHERE TRIM("mes") = $1`,
        [mesRef]
      );
      forecastPecas = Number(fc.rows[0]?.forecast || 0);

      const dias = diasDoPeriodo(dtInicio.slice(0, 10), dtFim.slice(0, 10));
      const mesesPeriodo = [...new Set(dias.map(d => d.slice(0, 4) + d.slice(5, 7)))];

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
          WHERE ${cfgCanal ? `TRIM("modalidade") ILIKE '%${cfgCanal.re}%'` : `UPPER(TRIM("modalidade")) = 'TOTAL'`}
            AND LEFT(TRIM("data"), 6) = $1
          LIMIT 1`,
        [mesRef]
      );
      if (pct.rows[0]) {
        integVsFcst = (pct.rows[0].integrado || '0,00%').trim();
        prodVsFcst = (pct.rows[0].produzido || '0,00%').trim();
      }
    } catch (e) {
      console.error('Aviso: erro ao buscar forecast:', e.message);
    }

    const imp = kpisImportados.rows[0] || {};
    const st = kpisStatus.rows[0] || {};
    const prod = kpisProduzidos.rows[0] || {};
    const exp = kpisExpedidos.rows[0] || {};

    const resposta = {
      forecast_pecas: forecastPecas,
      forecast_diario: forecastDiario,
      pecas_integradas: Number(imp.total_integradas || 0),
      pedidos_integradas: Number(imp.pedidos_integrados || 0),
      pecas_fluxo: Number(st.total_fluxo || 0),
      pedidos_fluxo: Number(st.pedidos_fluxo || 0),
      em_coleta: Number(st.total_coleta || 0),
      pedidos_coleta: Number(st.pedidos_coleta || 0),
      em_tratativa: Number(st.total_tratativa || 0),
      pedidos_tratativa: Number(st.pedidos_tratativa || 0),
      pecas_produzidas: Number(prod.total_produzidas || 0),
      pedidos_produzidas: Number(prod.pedidos_produzidos || 0),
      pecas_expedidas: Number(exp.total_expedidas || 0),
      pedidos_expedidas: Number(exp.pedidos_expedidos || 0),
      pecas_integradas_grafico: graficoIntegradas.rows || [],
      pecas_faturadas_grafico: graficoFaturados.rows || [],
      pecas_expedidas_grafico: graficoExpedidas.rows || [],
      pecas_status_grafico: graficoStatus.rows || [],
      sla_pct: '100,00%',
      integrado_vs_fcst: integVsFcst,
      produzido_vs_fcst: prodVsFcst,
      ultima_atualizacao: await ultimaAtualizacao()
    };

    await responderComCache(res, chaveOutbound, resposta,
      d => d.pecas_integradas === 0 && d.pecas_produzidas === 0 && d.pecas_expedidas === 0);
  } catch (err) {
    await erroComCache(res, chaveOutbound, err, 'Erro no Outbound');
  }
});

// ROUTE 3: RESUMO DE NF
app.get('/api/notas-fluxo', async (req, res) => {
  try {
    if (await servirCacheSeRecarga(res, 'resumo-nf', ['itens'])) return;

    const infoNF = await detectarColunasItens();
    const colDestNF = infoNF.colunas.find(c => normNome(c) === 'destinatario');
    const exprDest = colDestNF ? aspas(colDestNF) : `NULL::text`;

    const chaveNF = `COALESCE(NULLIF(TRIM("nota_fiscal"::text), ''), 'SEM NF - ' || COALESCE("pedido_de_venda"::text, 'SEM PEDIDO'))`;

    const base = `
      WITH base AS (
        SELECT
          ${chaveNF} AS nota_fiscal,
          COALESCE(NULLIF(TRIM("status_operacional"), ''), 'SEM STATUS') AS status,
          COALESCE(NULLIF(TRIM("canal"), ''), 'SEM CANAL') AS canal,
          MAX(${exprDest}) AS destinatario,
          MAX(CASE WHEN TRIM("qtde_de_produto"::text) ~ '^[0-9]+([.,][0-9]+)?$'
                   THEN REPLACE(TRIM("qtde_de_produto"::text), ',', '.')::numeric END) AS skus,
          COALESCE(SUM("quantidade"), 0) AS pecas,
          COUNT(DISTINCT "pedido_de_venda") AS pedidos
        FROM "itens"
        WHERE COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'
        GROUP BY ${chaveNF},
                 COALESCE(NULLIF(TRIM("status_operacional"), ''), 'SEM STATUS'),
                 COALESCE(NULLIF(TRIM("canal"), ''), 'SEM CANAL')
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
      ORDER BY (CASE WHEN status ILIKE '%corte%' OR status ILIKE '%reten%' OR status ILIKE '%tratativa%' THEN 0 ELSE 1 END),
               pecas DESC
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
      ORDER BY pecas DESC
    `);

    const porCanal = await pool.query(`
      ${base}
      SELECT
        canal,
        COUNT(DISTINCT nota_fiscal) AS notas,
        COALESCE(SUM(skus), 0) AS skus,
        COALESCE(SUM(pecas), 0) AS pecas
      FROM base
      GROUP BY canal
      ORDER BY pecas DESC
    `);

    const totais = await pool.query(`
      ${base}
      SELECT
        COUNT(*) AS total_notas,
        COALESCE(SUM(skus), 0) AS total_skus,
        COALESCE(SUM(pecas), 0) AS total_pecas
      FROM nf
    `);

    const trat = await pool.query(`
      ${base}
      SELECT COUNT(DISTINCT nota_fiscal) AS notas, COALESCE(SUM(pecas), 0) AS pecas
      FROM base
      WHERE status ILIKE '%reten%' OR status ILIKE '%tratativa%' OR status ILIKE '%corte%'
    `);

    const resposta = {
      total_notas: Number(totais.rows[0]?.total_notas || 0),
      total_skus: Number(totais.rows[0]?.total_skus || 0),
      total_pecas: Number(totais.rows[0]?.total_pecas || 0),
      em_tratativa_notas: Number(trat.rows[0]?.notas || 0),
      em_tratativa_pecas: Number(trat.rows[0]?.pecas || 0),
      por_status: porStatus.rows || [],
      por_canal: porCanal.rows || [],
      notas: notas.rows || [],
      ultima_atualizacao: await ultimaAtualizacao()
    };

    await responderComCache(res, 'resumo-nf', resposta, d => d.total_pecas === 0 && d.total_notas === 0);
  } catch (err) {
    await erroComCache(res, 'resumo-nf', err, 'Erro Resumo NF');
  }
});

// ROUTE 4: ENTRADA (RECEBIMENTO E DEVOLUÇÃO)
const TIPOS_INBOUND = {
  recebimento: { regra: '^compra', colForecast: 'recebimento', modal: '^(receb|compra)' },
  devolucao:   { regra: '^devol',  colForecast: 'devolucao',   modal: '^devol' }
};

function percentualCheio(txt) {
  const n = parseFloat(String(txt ?? '').replace('%', '').replace(/\./g, '').replace(',', '.'));
  if (isNaN(n)) return '0%';
  const v = Math.abs(n) <= 10 ? n * 100 : n;
  return Number(v.toFixed(2)).toString().replace('.', ',') + '%';
}

const dataSQL = col => `(CASE
    WHEN TRIM(${col}::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN LEFT(TRIM(${col}::text), 10)::date
    WHEN TRIM(${col}::text) ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}' THEN TO_DATE(LEFT(TRIM(${col}::text), 10), 'DD/MM/YYYY')
    WHEN TRIM(${col}::text) ~ '^[0-9]{8}$' THEN TO_DATE(TRIM(${col}::text), 'YYYYMMDD')
  END)`;

app.get('/api/inbound', async (req, res) => {
  const tipoKey = String(req.query.tipo || '').toLowerCase() === 'devolucao' ? 'devolucao' : 'recebimento';
  const cfg = TIPOS_INBOUND[tipoKey];

  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = String(hoje.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(ano, hoje.getMonth() + 1, 0).getDate();
  const valida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dIni = valida(req.query.data_inicio) ? req.query.data_inicio : `${ano}-${mes}-01`;
  const dFim = valida(req.query.data_fim) ? req.query.data_fim : `${ano}-${mes}-${String(ultimoDia).padStart(2, '0')}`;
  const chave = `inbound:${tipoKey}:${dIni}:${dFim}`;

  try {
    if (await servirCacheSeRecarga(res, chave, ['entrada_consolidada'])) return;

    const filtroBase = `
      TRIM("regra") ~* '${cfg.regra}'
      AND COALESCE("status_processo", '') NOT ILIKE '%cancel%'
      AND COALESCE("status", '') NOT ILIKE '%cancel%'`;
    const sub = colData => `(
      SELECT ${dataSQL(colData)} AS d,
             COALESCE("qtde_de_peças", 0) AS q,
             "or" AS orr,
             COALESCE("status_processo", '') AS sp
      FROM "entrada_consolidada"
      WHERE ${filtroBase}
    ) t`;
    const noPeriodo = `t.d BETWEEN $1::date AND $2::date`;
    const params = [dIni, dFim];
    const cad = '"data_de_cadastro_da_or"';
    const fim = '"data_fim_alocação"';

    const kRec = await pool.query(`
      SELECT
        COALESCE(SUM(q), 0) AS pecas,
        COUNT(DISTINCT orr) AS ors,
        COALESCE(SUM(CASE WHEN sp NOT ILIKE '%armazen%' THEN q END), 0) AS fluxo_pecas,
        COUNT(DISTINCT CASE WHEN sp NOT ILIKE '%armazen%' THEN orr END) AS fluxo_ors
      FROM ${sub(cad)} WHERE ${noPeriodo}`, params);

    const kArm = await pool.query(`
      SELECT COALESCE(SUM(q), 0) AS pecas, COUNT(DISTINCT orr) AS ors
      FROM ${sub(fim)} WHERE ${noPeriodo}`, params);

    const gInteg = await pool.query(`
      SELECT t.d AS data, COALESCE(SUM(q), 0) AS total_pecas
      FROM ${sub(cad)} WHERE ${noPeriodo} GROUP BY t.d ORDER BY t.d`, params);

    const gArm = await pool.query(`
      SELECT t.d AS data, COALESCE(SUM(q), 0) AS total_pecas
      FROM ${sub(fim)} WHERE ${noPeriodo} GROUP BY t.d ORDER BY t.d`, params);

    const gStatus = await pool.query(`
      SELECT t.d AS data,
             COALESCE(SUM(CASE WHEN sp ILIKE '%armazen%' THEN q END), 0) AS armazenadas,
             COALESCE(SUM(CASE WHEN sp NOT ILIKE '%armazen%' THEN q END), 0) AS fluxo
      FROM ${sub(cad)} WHERE ${noPeriodo} GROUP BY t.d ORDER BY t.d DESC`, params);

    let statusProcessos = [];
    try {
      const sp = await pool.query(`
        SELECT COALESCE(NULLIF(TRIM("status_processo"), ''), '(vazio)') AS status, COUNT(*) AS linhas
        FROM "entrada_consolidada" WHERE TRIM("regra") ~* '${cfg.regra}'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
      statusProcessos = sp.rows;
    } catch (e) {}

    const mesRef = dIni.slice(0, 4) + dIni.slice(5, 7);
    let forecastPecas = 0;
    const forecastDiario = [];
    let armzXFcst = '0%';
    let sla24h = '-';
    let sla = '-';
    try {
      const dias = diasDoPeriodo(dIni, dFim);
      const mesesPeriodo = [...new Set(dias.map(d => d.slice(0, 4) + d.slice(5, 7)))];
      const fm = await pool.query(`
        SELECT LEFT(REGEXP_REPLACE(TRIM("mes"), '[^0-9]', '', 'g'), 6) AS mes,
               COALESCE(SUM("${cfg.colForecast}"), 0) AS valor
        FROM "forecast_inbound"
        WHERE LEFT(REGEXP_REPLACE(TRIM("mes"), '[^0-9]', '', 'g'), 6) = ANY($1::text[])
        GROUP BY 1`, [mesesPeriodo]);
      const totalPorMes = {};
      fm.rows.forEach(r => { totalPorMes[r.mes] = Number(r.valor || 0); });
      forecastPecas = totalPorMes[mesRef] || 0;

      dias.forEach(iso => {
        if (!ehDiaUtil(iso)) return;
        const mk = iso.slice(0, 4) + iso.slice(5, 7);
        const total = totalPorMes[mk] || 0;
        if (total <= 0) return;
        const uteis = diasUteisDoMes(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
        forecastDiario.push({ data: iso, valor: Math.round(total / uteis) });
      });

      const pc = await pool.query(`
        SELECT "produzido_x_forecast_" AS armz, "_sla_24h" AS sla24, "_sla" AS sla
        FROM "entrada_consolidada_porcentagem"
        WHERE TRIM("modalidade") ~* $2 AND LEFT(TRIM("data"), 6) = $1
        LIMIT 1`, [mesRef, cfg.modal]);
      if (pc.rows[0]) {
        armzXFcst = percentualCheio(pc.rows[0].armz);
        sla24h = (pc.rows[0].sla24 || '-').trim();
        sla = (pc.rows[0].sla || '-').trim();
      }
    } catch (e) {
      console.error('Aviso: erro ao buscar forecast inbound:', e.message);
    }

    const r1 = kRec.rows[0] || {};
    const r2 = kArm.rows[0] || {};
    const resposta = {
      tipo: tipoKey,
      forecast_pecas: forecastPecas,
      pecas_recebidas: Number(r1.pecas || 0),
      or_recebidas: Number(r1.ors || 0),
      pecas_fluxo: Number(r1.fluxo_pecas || 0),
      or_fluxo: Number(r1.fluxo_ors || 0),
      pecas_armazenadas: Number(r2.pecas || 0),
      or_armazenadas: Number(r2.ors || 0),
      armz_x_fcst: armzXFcst,
      sla_24h: sla24h,
      sla: sla,
      pecas_integradas_grafico: gInteg.rows,
      pecas_armazenadas_grafico: gArm.rows,
      pecas_status_grafico: gStatus.rows,
      forecast_diario: forecastDiario,
      status_processos: statusProcessos,
      ultima_atualizacao: await ultimaAtualizacao()
    };

    await responderComCache(res, chave, resposta, d => d.pecas_recebidas === 0 && d.pecas_armazenadas === 0);
  } catch (err) {
    await erroComCache(res, chave, err, 'Erro Entrada');
  }
});

// ROUTE 5: OUTBOUND - EXPEDIÇÃO
let infoItens = null;
let infoItensEm = 0;

async function detectarColunasItens() {
  if (infoItens && Date.now() - infoItensEm < 10 * 60 * 1000) return infoItens;
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'itens' ORDER BY ordinal_position`
  );
  const colunas = r.rows.map(x => x.column_name);
  const achar = fn => colunas.find(c => fn(normNome(c)));

  const colTransp = achar(n => n === 'transportadora') || achar(n => n.includes('transportadora')) || achar(n => n.includes('transportador'));

  const preferidas = ['coleta', 'numero_coleta', 'id_coleta', 'carga', 'pre_carga', 'titulo_romaneio'];
  let colColeta = null;
  for (const p of preferidas) {
    const c = colunas.find(x => normNome(x) === p);
    if (c) { colColeta = c; break; }
  }
  if (!colColeta) {
    const candidatas = colunas.filter(c => {
      const n = normNome(c);
      return n.includes('coleta') && !n.endsWith('_em') && !n.includes('status') && !n.includes('data') && !n.includes('usuario');
    });
    colColeta = candidatas[0] || null;
  }

  infoItens = { colunas, colTransp, colColeta };
  infoItensEm = Date.now();
  return infoItens;
}

app.get('/api/expedicao', async (req, res) => {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = String(hoje.getMonth() + 1).padStart(2, '0');
  const ultimoDia = new Date(ano, hoje.getMonth() + 1, 0).getDate();
  const valida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const dIni = valida(req.query.data_inicio) ? req.query.data_inicio : `${ano}-${mes}-01`;
  const dFim = valida(req.query.data_fim) ? req.query.data_fim : `${ano}-${mes}-${String(ultimoDia).padStart(2, '0')}`;
  const chave = `expedicao:${dIni}:${dFim}`;

  try {
    if (await servirCacheSeRecarga(res, chave, ['itens'])) return;

    const info = await detectarColunasItens();
    const transp = info.colTransp
      ? `COALESCE(NULLIF(TRIM(${aspas(info.colTransp)}::text), ''), 'SEM TRANSPORTADORA')`
      : `'SEM TRANSPORTADORA'`;
    const coleta = info.colColeta ? `NULLIF(TRIM(${aspas(info.colColeta)}::text), '')` : `NULL::text`;
    const semCancelado = `COALESCE("status_operacional", '') NOT ILIKE '%cancelad%'`;
    const agCarreg = `COALESCE("status_operacional", '') ILIKE '%aguardando exped%'`;
    const ini = dIni + ' 00:00:00';
    const fim = dFim + ' 23:59:59';

    const k = await pool.query(`
      SELECT
        COUNT(DISTINCT NULLIF(${transp}, 'SEM TRANSPORTADORA')) AS transportadoras,
        COALESCE(SUM("quantidade"), 0) AS pecas,
        COUNT(DISTINCT "nota_fiscal") AS nfs,
        COUNT(DISTINCT ${coleta}) AS coletas
      FROM "itens"
      WHERE ${agCarreg} AND ${semCancelado}`);

    const td = await pool.query(`
      SELECT DATE(COALESCE(NULLIF("conferido_em"::text, ''), "importado_em"::text)::timestamp) AS data,
             ${transp} AS transportadora,
             COALESCE(SUM("quantidade"), 0) AS pecas
      FROM "itens"
      WHERE ${agCarreg} AND ${semCancelado}
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC`);

    const periodo = `"processado_em"::timestamp >= $1::timestamp AND "processado_em"::timestamp <= $2::timestamp AND ${semCancelado}`;

    const em = await pool.query(`
      SELECT COALESCE(SUM("quantidade"), 0) AS pecas FROM "itens" WHERE ${periodo}`, [ini, fim]);

    const et = await pool.query(`
      SELECT ${transp} AS transportadora, COALESCE(SUM("quantidade"), 0) AS pecas
      FROM "itens" WHERE ${periodo}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [ini, fim]);

    const procTs = `NULLIF(TRIM("processado_em"::text), '')::timestamp`;
    const impTs  = `NULLIF(TRIM("importado_em"::text), '')::timestamp`;
    const porDia = idExpr => `
      SELECT TO_CHAR(data, 'YYYY-MM-DD') AS data,
             COUNT(DISTINCT id) FILTER (WHERE tipo = 'exp') AS expedido,
             COUNT(DISTINCT id) FILTER (WHERE tipo = 'sem') AS sem_coleta
      FROM (
        SELECT DATE(${procTs}) AS data, ${idExpr} AS id, 'exp' AS tipo
        FROM "itens"
        WHERE ${procTs} >= $1::timestamp AND ${procTs} <= $2::timestamp AND ${semCancelado}
        UNION ALL
        SELECT DATE(${impTs}) AS data, ${idExpr} AS id, 'sem' AS tipo
        FROM "itens"
        WHERE ${impTs} >= $1::timestamp AND ${impTs} <= $2::timestamp
          AND ${procTs} IS NULL AND ${semCancelado}
          AND ${agCarreg}
      ) t
      GROUP BY data
      ORDER BY data DESC`;

    const nfs = await pool.query(porDia(`"nota_fiscal"::text`), [ini, fim]);
    const col = await pool.query(porDia(coleta), [ini, fim]);

    const k0 = k.rows[0] || {};
    const resposta = {
      transportadoras: Number(k0.transportadoras || 0),
      pecas_ag_carregamento: Number(k0.pecas || 0),
      nfs_ag_carregamento: Number(k0.nfs || 0),
      coletas_ag_carregamento: Number(k0.coletas || 0),
      transp_dia: td.rows.map(r => ({ data: r.data, transportadora: r.transportadora, pecas: Number(r.pecas) })),
      expedidas_mes: Number(em.rows[0]?.pecas || 0),
      expedidas_transportadora: et.rows.map(r => ({ transportadora: r.transportadora, pecas: Number(r.pecas) })),
      nfs_dia: nfs.rows.map(r => ({ data: r.data, expedido: Number(r.expedido), sem_coleta: Number(r.sem_coleta) })),
      coletas_dia: col.rows.map(r => ({ data: r.data, expedido: Number(r.expedido), sem_coleta: Number(r.sem_coleta) })),
      diagnostico: { col_transportadora: info.colTransp || null, col_coleta: info.colColeta || null, colunas_itens: info.colunas },
      ultima_atualizacao: await ultimaAtualizacao()
    };

    await responderComCache(res, chave, resposta,
      d => d.pecas_ag_carregamento === 0 && d.expedidas_mes === 0 && d.nfs_ag_carregamento === 0);
  } catch (err) {
    await erroComCache(res, chave, err, 'Erro Expedição');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});