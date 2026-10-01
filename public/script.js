// Função para renderizar cada gráfico com o padrão visual da dashboard
function renderizarGraficoOcupacao(canvasId, labels, capacidade, ocupados, livres) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return; // Proteção caso o canvas ainda não exista no HTML

  const ctx = canvas.getContext('2d');

  // Destrói o gráfico anterior se já existir, evitando bugs de sobreposição ao atualizar
  if (window[canvasId + '_chart']) {
    window[canvasId + '_chart'].destroy();
  }

  window[canvasId + '_chart'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Capacidade',
          data: capacidade,
          backgroundColor: '#B57EDC', // Roxo
          stack: 'stack1',
          barPercentage: 0.6
        },
        {
          label: 'Ocupados',
          data: ocupados,
          backgroundColor: '#3B82F6', // Azul
          stack: 'stack2',
          barPercentage: 0.6
        },
        {
          label: 'Livres',
          data: livres,
          backgroundColor: '#40C000', // Verde
          stack: 'stack2',
          barPercentage: 0.6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false
        }
      },
      scales: {
        x: {
          stacked: false,
          ticks: { color: '#FFFFFF', font: { weight: 'bold', size: 11 } },
          grid: { display: false }
        },
        y: {
          stacked: false,
          ticks: { color: '#888888' },
          grid: { color: '#222222' }
        }
      }
    }
  });
}

// Função principal de carregamento da Dashboard via API
async function carregarDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();

    if (data.error) {
      console.error('Erro retornado pela API:', data.detalhe);
      return;
    }

    // 1. Preenchendo a Data da Última Atualização (se existir o elemento)
    const elData = document.getElementById('ultimaAtualizacao');
    if (elData && data.ultima_atualizacao) {
      elData.innerText = `Última Atualização: ${data.ultima_atualizacao}`;
    }

    // 2. Extraindo os dados do banco para montar os gráficos
    const graficosData = data.graficos || [];
    const categoriasPicking = graficosData.map(g => g.categoria);

    // Gráfico 1: Ocupação Peças - Picking
    renderizarGraficoOcupacao(
      'chartPecasPicking',
      categoriasPicking,
      graficosData.map(g => Number(g.pecas_capacidade || 0)),
      graficosData.map(g => Number(g.pecas_ocupadas || 0)),
      graficosData.map(g => Number(g.pecas_livres || 0))
    );

    // Gráfico 2: Ocupação Posições - Picking
    renderizarGraficoOcupacao(
      'chartPosicoesPicking',
      categoriasPicking,
      graficosData.map(g => Number(g.posicoes_capacidade || 0)),
      graficosData.map(g => Number(g.posicoes_ocupadas || 0)),
      graficosData.map(g => Number(g.posicoes_livres || 0))
    );

    // Filtrando apenas a categoria de Pulmão para os gráficos da direita
    const pulmaoData = graficosData.filter(g => g.categoria && g.categoria.includes('PULMÃO'));
    const categoriasPulmao = pulmaoData.map(g => g.categoria);

    // Gráfico 3: Ocupação Peças - Pulmão
    renderizarGraficoOcupacao(
      'chartPecasPulmao',
      categoriasPulmao,
      pulmaoData.map(g => Number(g.pecas_capacidade || 0)),
      pulmaoData.map(g => Number(g.pecas_ocupadas || 0)),
      pulmaoData.map(g => Number(g.pecas_livres || 0))
    );

    // Gráfico 4: Ocupação Posições - Pulmão
    renderizarGraficoOcupacao(
      'chartPosicoesPulmao',
      categoriasPulmao,
      pulmaoData.map(g => Number(g.posicoes_capacidade || 0)),
      pulmaoData.map(g => Number(g.posicoes_ocupadas || 0)),
      pulmaoData.map(g => Number(g.posicoes_livres || 0))
    );

  } catch (err) {
    console.error('Falha ao conectar com o servidor:', err);
  }
}

// Inicializa a dashboard assim que a página carregar
document.addEventListener('DOMContentLoaded', carregarDashboard);