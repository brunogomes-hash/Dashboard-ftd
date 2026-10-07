/* =====================================================================
   escala.js  -  Escala da tela (notebook / tablet / TV em F11) e hover
   dos gráficos.

   COMO USAR: salve este arquivo na MESMA pasta do index.html e adicione
   esta linha no index.html, logo ACIMA do <script> principal (o que começa
   com "const LOGO_LUFT"):

       <script src="escala.js"></script>

   Não precisa mexer em mais nada.
   ===================================================================== */
(function () {
  'use strict';

  // ---------- 1) Estilos ----------
  const css = `
    html, body { height: 100%; overflow: hidden; }
    body { padding: 0 !important; }

    /* Tudo fica dentro de #app, que é ampliado com transform: scale */
    #app {
      width: calc(100% / var(--esc, 1));
      height: var(--altura, 100vh);
      transform: scale(var(--esc, 1));
      transform-origin: 0 0;
      padding: 12px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    #app::-webkit-scrollbar { width: 10px; }
    #app::-webkit-scrollbar-thumb { background: #333; border-radius: 6px; }
    #app::-webkit-scrollbar-track { background: #0b0c10; }

    /* Alturas passam a usar a altura "efetiva" (já dividida pela escala) */
    .grid-container { height: calc(var(--altura, 100vh) - 185px) !important; min-height: 480px !important; }
    .outbound-body-grid { height: calc(var(--altura, 100vh) - 266px) !important; min-height: 380px !important; }
    .outbound-header { flex-wrap: wrap; row-gap: 6px; }

    /* Controle de escala na barra de apresentação */
    .controle-escala { display: flex; align-items: center; gap: 6px; }

    /* Telas estreitas (tablet em pé / notebook muito ampliado): empilha os blocos */
    #app.estreito .outbound-body-grid { grid-template-columns: 1fr !important; grid-template-rows: none !important; height: auto !important; min-height: 0 !important; }
    #app.estreito .center-charts, #app.estreito .right-stack { height: auto !important; }
    #app.estreito .chart-panel { flex: none !important; height: 300px !important; }
    #app.estreito .sub-row { flex: none !important; height: 300px !important; }
    #app.estreito .right-chart { height: 460px !important; }
    #app.estreito .grid-container { grid-template-columns: 1fr !important; grid-template-rows: none !important; height: auto !important; min-height: 0 !important; }
    #app.estreito .grid-container > .section-card,
    #app.estreito .col-direita .section-card { height: 640px !important; flex: none !important; }
    #app.estreito .top-kpis-grid,
    #app.estreito .top-kpis-grid.cinco,
    #app.estreito .top-kpis-grid.quatro { grid-template-columns: repeat(2, 1fr) !important; }
    #app.estreito .nf-grid { grid-template-columns: 1fr !important; }
  `;
  const estilo = document.createElement('style');
  estilo.id = 'estilo-escala';
  estilo.textContent = css;
  document.head.appendChild(estilo);

  // ---------- 2) Envolve o conteúdo da página em #app ----------
  const app = document.createElement('div');
  app.id = 'app';
  Array.from(document.body.childNodes)
    .filter(n => n.nodeName !== 'SCRIPT')
    .forEach(n => app.appendChild(n));
  document.body.insertBefore(app, document.body.firstChild);

  // ---------- 3) Escala (Auto ou fixa) ----------
  const OPCOES = [
    ['auto', 'Auto'], ['1', '100%'], ['1.15', '115%'], ['1.3', '130%'],
    ['1.5', '150%'], ['1.75', '175%'], ['2', '200%'], ['2.5', '250%']
  ];
  let pref = 'auto';
  try { pref = localStorage.getItem('dash_escala') || 'auto'; } catch (e) {}
  if (!OPCOES.some(o => o[0] === pref)) pref = 'auto';

  function calcularEscala() {
    if (pref === 'auto') return Math.min(2.5, Math.max(1, window.innerWidth / 1500));
    return Number(pref) || 1;
  }

  function aplicarEscala() {
    const esc = calcularEscala();
    const raiz = document.documentElement.style;
    raiz.setProperty('--esc', String(esc));
    raiz.setProperty('--altura', (window.innerHeight / esc) + 'px');
    app.classList.toggle('estreito', (window.innerWidth / esc) < 960);

    // Gráficos nítidos mesmo ampliados: o canvas é desenhado com mais pixels
    const dpr = (window.devicePixelRatio || 1) * esc;
    if (window.Chart) {
      Chart.defaults.devicePixelRatio = dpr;
      try {
        Object.values(Chart.instances || {}).forEach(c => {
          c.options.devicePixelRatio = dpr;
          c.resize();
        });
      } catch (e) { /* os gráficos são recriados a cada carga */ }
    }
  }

  // ---------- 4) Seletor de escala na barra de apresentação ----------
  function criarControle() {
    const barra = document.querySelector('.apresentacao');
    if (!barra) return;
    const caixa = document.createElement('div');
    caixa.className = 'controle-escala';
    caixa.innerHTML = '<span>Escala:</span>';
    const sel = document.createElement('select');
    sel.id = 'sel-escala';
    OPCOES.forEach(([valor, nome]) => {
      const o = document.createElement('option');
      o.value = valor;
      o.textContent = nome;
      sel.appendChild(o);
    });
    sel.value = pref;
    sel.addEventListener('change', () => {
      pref = sel.value;
      try { localStorage.setItem('dash_escala', pref); } catch (e) {}
      aplicarEscala();
    });
    caixa.appendChild(sel);
    barra.insertBefore(caixa, barra.firstChild);
  }

  // Reaplica ao redimensionar (inclui entrar/sair do F11)
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(aplicarEscala, 200);
  });

  // ---------- 5) Hover dos gráficos: basta passar o mouse na coluna/linha ----------
  if (window.Chart) {
    Chart.defaults.interaction.mode = 'index';
    Chart.defaults.interaction.intersect = false;
    Chart.defaults.elements.point.hitRadius = 16;

    const tt = Chart.defaults.plugins.tooltip;
    tt.padding = 10;
    tt.bodyFont = { size: 13 };
    tt.titleFont = { size: 13 };
    tt.callbacks.label = function (ctx) {
      const v = (ctx.parsed && ctx.parsed.y !== undefined && ctx.parsed.y !== null) ? ctx.parsed.y : ctx.parsed.x;
      const num = (typeof fmt === 'function') ? fmt(v) : v;
      return ctx.dataset.label ? `${ctx.dataset.label}: ${num}` : String(num);
    };

    // Gráficos horizontais pesquisam pelo eixo Y
    Chart.register({
      id: 'hoverPorEixo',
      beforeInit(chart) {
        const eixo = chart.options.indexAxis === 'y' ? 'y' : 'x';
        const inter = chart.options.interaction || (chart.options.interaction = {});
        inter.mode = 'index';
        inter.intersect = false;
        inter.axis = eixo;
        const t = chart.options.plugins && chart.options.plugins.tooltip;
        if (t) { t.mode = 'index'; t.intersect = false; t.axis = eixo; }
      }
    });
  }

  criarControle();
  aplicarEscala();
})();