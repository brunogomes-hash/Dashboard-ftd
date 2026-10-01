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
    // 1. Total Peças e SKUs vindo da tabela estoque
    const pecasEstoque = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_estoque,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
    `).catch(err => {
      console.error("Erro pecasEstoque:", err.message);
      return { rows: [{ total_estoque: 0, total_skus: 0 }] };
    });

    // 2. Posições e Ocupação Geral vindo da tabela Locais_ftd
    const posicoesGerais = await pool.query(`
      SELECT 
        COUNT(*) AS total_posicoes,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '1' THEN 1 END) AS posicoes_ocupadas,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '0' OR "estoque" IS NULL THEN 1 END) AS posicoes_vazias
      FROM "Locais_ftd"
      WHERE "ativo" ILIKE 'S'
        AND ("obs" IS NULL OR "obs" = '')
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
    `).catch(err => {
      console.error("Erro posicoesGerais:", err.message);
      return { rows: [{ total_posicoes: 0, posicoes_ocupadas: 0, posicoes_vazias: 0 }] };
    });

    // 3. Picking (Estoque e Posicoes)
    const pickingPecas = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND "tipo_do_local" ILIKE '%PICKING%'
    `).catch(err => ({ rows: [{ total_pecas: 0, total_skus: 0 }] }));

    const pickingPosicoes = await pool.query(`
      SELECT 
        COUNT(*) AS capacidade,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '1' THEN 1 END) AS ocupadas,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '0' OR "estoque" IS NULL THEN 1 END) AS vazias
      FROM "Locais_ftd"
      WHERE "ativo" ILIKE 'S'
        AND ("obs" IS NULL OR "obs" = '')
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND ("tipo_do_local" ILIKE '%PICKING%' OR "tipo" ILIKE '%PICKING%')
    `).catch(err => ({ rows: [{ capacidade: 0, ocupadas: 0, vazias: 0 }] }));

    // 4. Pulmão (Estoque e Posicoes)
    const pulmaoPecas = await pool.query(`
      SELECT 
        COALESCE(SUM("disponível"), 0) AS total_pecas,
        COUNT(DISTINCT "código_do_produto") AS total_skus
      FROM "estoque"
      WHERE ("local_ativo" ILIKE 'S' OR "local_ativo" ILIKE 'ATIVO' OR "local_ativo" = '1')
        AND ("estado" ILIKE 'NORMAL' OR "estado" IS NULL)
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND ("tipo_do_local" ILIKE '%PULMÃO%' OR "tipo_do_local" ILIKE '%PULMAO%')
    `).catch(err => ({ rows: [{ total_pecas: 0, total_skus: 0 }] }));

    const pulmaoPosicoes = await pool.query(`
      SELECT 
        COUNT(*) AS capacidade,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '1' THEN 1 END) AS ocupadas,
        COUNT(CASE WHEN CAST("estoque" AS TEXT) = '0' OR "estoque" IS NULL THEN 1 END) AS vazias
      FROM "Locais_ftd"
      WHERE "ativo" ILIKE 'S'
        AND ("obs" IS NULL OR "obs" = '')
        AND ("area" IN ('PP', 'PR', 'PQ', 'SP') OR "setor" IN ('PP', 'PR', 'PQ', 'SP') OR "rua"::text IN ('PP', 'PR', 'PQ', 'SP'))
        AND ("tipo_do_local" ILIKE '%PULMÃO%' OR "tipo_do_local" ILIKE '%PULMAO%' OR "tipo" ILIKE '%PULMÃO%' OR "tipo" ILIKE '%PULMAO%')
    `).catch(err => ({ rows: [{ capacidade: 0, ocupadas: 0, vazias: 0 }] }));

    // 5. Gráficos de Ocupação
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
    `).catch(err => ({ rows: [] }));

    res.json({
      gerais: {
        total_estoque: pecasEstoque.rows[0]?.total_estoque || 0,
        total_skus: pecasEstoque.rows[0]?.total_skus || 0,
        total_posicoes: posicoesGerais.rows[0]?.total_posicoes || 0,
        posicoes_ocupadas: posicoesGerais.rows[0]?.posicoes_ocupadas || 0,
        posicoes_vazias: posicoesGerais.rows[0]?.posicoes_vazias || 0
      },
      picking: {
        total_pecas: pickingPecas.rows[0]?.total_pecas || 0,
        total_skus: pickingPecas.rows[0]?.total_skus || 0,
        capacidade: pickingPosicoes.rows[0]?.capacidade || 0,
        ocupadas: pickingPosicoes.rows[0]?.ocupadas || 0,
        vazias: pickingPosicoes.rows[0]?.vazias || 0
      },
      pulmao: {
        total_pecas: pulmaoPecas.rows[0]?.total_pecas || 0,
        total_skus: pulmaoPecas.rows[0]?.total_skus || 0,
        capacidade: pulmaoPosicoes.rows[0]?.capacidade || 0,
        ocupadas: pulmaoPosicoes.rows[0]?.ocupadas || 0,
        vazias: pulmaoPosicoes.rows[0]?.vazias || 0
      },
      graficos: graficos.rows || [],
      ultima_atualizacao: new Date().toLocaleString('pt-BR')
    });
  } catch (err) {
    console.error('Erro geral no endpoint:', err);
    res.status(500).json({ error: 'Erro interno do servidor', detalhe: err.message });
  }
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});