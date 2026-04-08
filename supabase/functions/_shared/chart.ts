/**
 * chart.ts
 * Gera graficos financeiros como imagem PNG (base64) via QuickChart.io.
 * Usa Chart.js renderizado server-side — zero dependencias alem de fetch.
 */

// Cores por categoria (paleta fixa para consistencia visual)
const CATEGORY_COLORS: Record<string, string> = {
  alimentacao: "#FF6384",
  transporte:  "#36A2EB",
  moradia:     "#FFCE56",
  saude:       "#4BC0C0",
  lazer:       "#9966FF",
  educacao:    "#FF9F40",
  trabalho:    "#C9CBCF",
  outros:      "#7C8CF8",
};

// Nomes bonitos para as categorias
const CATEGORY_LABELS: Record<string, string> = {
  alimentacao: "Alimentacao",
  transporte:  "Transporte",
  moradia:     "Moradia",
  saude:       "Saude",
  lazer:       "Lazer",
  educacao:    "Educacao",
  trabalho:    "Trabalho",
  outros:      "Outros",
};

const DEFAULT_COLOR = "#A0AEC0";

function formatBRL(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

/**
 * Gera um grafico doughnut de gastos por categoria.
 * Retorna base64 PNG ou null se falhar.
 */
export async function generateExpenseChartBase64(params: {
  byCategory: Record<string, number>;
  periodLabel: string;
  totalExpense: number;
}): Promise<string | null> {
  const { byCategory, periodLabel, totalExpense } = params;

  const entries = Object.entries(byCategory)
    .filter(([_, val]) => val > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  // Monta labels com nome + valor + percentual
  const labels = entries.map(([cat, val]) => {
    const pct = totalExpense > 0 ? Math.round((val / totalExpense) * 100) : 0;
    const name = CATEGORY_LABELS[cat] || cat;
    return `${name} - ${formatBRL(val)} (${pct}%)`;
  });

  const data = entries.map(([_, val]) => val);
  const colors = entries.map(([cat]) => CATEGORY_COLORS[cat] || DEFAULT_COLOR);

  const chartConfig = {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: "#1a1a2e",
        borderWidth: 3,
      }],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `Gastos - ${periodLabel}`,
          color: "#ffffff",
          font: { size: 18, weight: "bold" },
          padding: { bottom: 10 },
        },
        legend: {
          position: "bottom",
          labels: {
            color: "#ffffff",
            font: { size: 11 },
            padding: 12,
            usePointStyle: true,
            pointStyle: "circle",
          },
        },
        doughnutlabel: {
          labels: [
            {
              text: formatBRL(totalExpense),
              font: { size: 22, weight: "bold" },
              color: "#ffffff",
            },
            {
              text: "Total",
              font: { size: 13 },
              color: "#aaaaaa",
            },
          ],
        },
      },
      layout: {
        padding: { top: 10, bottom: 10 },
      },
    },
  };

  const payload = {
    version: "2",
    backgroundColor: "#1a1a2e",
    width: 600,
    height: 600,
    format: "png",
    chart: chartConfig,
  };

  // Timeout de 5 segundos
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch("https://quickchart.io/chart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`QuickChart error: ${res.status} ${await res.text()}`);
      return null;
    }

    // Converte imagem para base64
    const arrayBuffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    const base64 = btoa(binary);

    return base64;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      console.error("QuickChart timeout after 5s");
    } else {
      console.error("QuickChart error:", err);
    }
    return null;
  }
}
