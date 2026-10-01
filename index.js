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

    // 2. SKUs e Peças por Tipo (Picking x Pulmão) da tabela estoque
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

    // 3. Tabela de Capacidade (Gráficos e Totais do Resumo)
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

    const rowsCapacidade = graficos.rows || [];

    // Soma Total do Armazém (Consolidado do Gráfico)
    const totalPosicoesGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0);
    const totalOcupadasGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0);
    const totalVaziasGeral = rowsCapacidade.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0);

    // Soma Picking (Categorias PR - PRATELEIRA, PQ - BLOCADO e PP - PICKING)
    const pickingRows = rowsCapacidade.filter(r => r.categoria && !r.categoria.includes('PP - PULMÃO'));
    const pickingCapacidade = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_capacidade || 0), 0);
    const pickingOcupadas = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_ocupadas || 0), 0);
    const pickingVazias = pickingRows.reduce((acc, r) => acc + Number(r.posicoes_livres || 0), 0);

    // Soma Pulmão (Categoria PP - PULMÃO)
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