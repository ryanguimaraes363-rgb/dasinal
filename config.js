window.DASINAL_CONFIG = {
  SUPABASE_URL: "https://rsfiypcckmlkdwsrxtsb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_K_UOcoUwsAmowSPgm0EsHQ_oM6otPzd",
  // "colaborativa": estimada pelos passageiros | "simulada": ônibus fictício | "supabase": tabela onibus (GPS externo)
  POSICAO_ONIBUS: "colaborativa",
  CENTRO_MAPA: [-20.0820, -44.5960],
  ZOOM_INICIAL: 14,
  INTERVALO_SIMULACAO_MS: 1000,
  VELOCIDADE_SIMULADA_KMH: 16,
  // De quanto em quanto tempo a posição colaborativa é recalculada.
  CICLO_ESTIMATIVA_MS: 5000,
  // Demonstração: passageiros fictícios nos ônibus. Com false, só aparece o
  // ônibus de quem tocar em "Estou neste ônibus" (e a mensagem de indisponível).
  DEMO_PASSAGEIROS_SIMULADOS: true
};
