/*
  Regras de pontos, níveis e conquistas (Dá sinal).

  Um lugar só para as regras: roda no navegador (modo demonstração) e na Edge
  Function do Supabase, como o estimador. JavaScript puro, sem dependências.

  Princípio: ponto é recompensa por AJUDAR DE VERDADE, não por deixar o GPS
  ligado. Por isso:
    - só viagens VALIDADAS pelo estimador pontuam (a pessoa esteve de fato num
      grupo que se comporta como ônibus por pelo menos 3 min);
    - os pontos só são calculados quando a viagem termina;
    - limites por dia (pontos e viagens) e um ajuste por confiabilidade:
      quem abre muitas viagens que não se confirmam passa a ganhar menos;
    - conquistas não dão pontos (não há o que "farmar").

  Uso:
    var r = DaSinalPontos.pontuarViagem(viagem, resumo);
    viagem: { id, linhaId, iniciadaEm (ms), encerradaEm (ms), validada, segundosValidos, maxJuntos }
    resumo: DaSinalPontos.resumoVazio() ou o devolvido na chamada anterior (r.resumo)
    r -> { itens: [{ tipo, pontos, descricao }], total, motivo, conquistasNovas: [codigo], resumo }
*/
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === "object" && module.exports) module.exports = api;
  raiz.DaSinalPontos = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var REGRAS = {
    PONTOS_INICIO: 1,              // começou e a viagem se confirmou
    PONTOS_VALIDADA: 10,           // viagem validada
    SEGUNDOS_POR_PONTO: 120,       // +1 a cada 2 min contribuindo...
    MAX_CONTRIBUICAO: 20,          // ...até 20 por viagem (40 min)
    PONTOS_CONFIRMADA: 5,          // outro passageiro confirmou o mesmo ônibus
    PONTOS_AVISO_CONFIRMADO: 3,    // aviso (atraso, lotação…) confirmado por 2 outras pessoas
    CONFIRMACOES_AVISO: 2,         // (as duas regras de aviso rodam no banco: 006_avisos.sql)
    LIMITE_PONTOS_DIA: 100,
    LIMITE_VIAGENS_DIA: 6,
    DURACAO_MIN_PENALIDADE_MS: 5 * 60000, // viagem curta que não validou não pesa na confiabilidade
    FUSO_HORAS: -3                 // dia contado no horário de Brasília
  };

  var NIVEIS = [
    { nivel: 1, nome: "Passageiro", min: 0 },
    { nivel: 2, nome: "Ajudante", min: 50 },
    { nivel: 3, nome: "Colaborador", min: 150 },
    { nivel: 4, nome: "Parceiro da linha", min: 400 },
    { nivel: 5, nome: "Guia do ponto", min: 800 },
    { nivel: 6, nome: "Sinal forte", min: 1500 },
    { nivel: 7, nome: "Lenda do busão", min: 3000 }
  ];

  var CONQUISTAS = [
    { codigo: "primeira_viagem", nome: "Primeira viagem", descricao: "Teve a primeira viagem validada.", teste: function (r) { return r.viagensValidadas >= 1; } },
    { codigo: "dez_viagens", nome: "Passageiro frequente", descricao: "10 viagens validadas.", teste: function (r) { return r.viagensValidadas >= 10; } },
    { codigo: "cinquenta_viagens", nome: "Veterano", descricao: "50 viagens validadas.", teste: function (r) { return r.viagensValidadas >= 50; } },
    { codigo: "tres_linhas", nome: "Explorador", descricao: "Viagens validadas em 3 linhas diferentes.", teste: function (r) { return r.linhas.length >= 3; } },
    { codigo: "uma_hora", nome: "Uma hora ajudando", descricao: "60 minutos de contribuição válida no total.", teste: function (r) { return r.segundos >= 3600; } },
    { codigo: "em_grupo", nome: "Em boa companhia", descricao: "Estimou o ônibus junto com mais 2 passageiros.", teste: function (r) { return r.maxJuntos >= 3; } },
    { codigo: "madrugador", nome: "Madrugador", descricao: "Viagem validada que começou antes das 7h.", teste: function (r) { return r.madrugador; } },
    { codigo: "cinco_dias", nome: "Constância", descricao: "Viagens validadas em 5 dias diferentes.", teste: function (r) { return r.dias.length >= 5; } }
  ];

  function dia(ms) {
    return new Date(ms + REGRAS.FUSO_HORAS * 3600000).toISOString().slice(0, 10);
  }

  function hora(ms) {
    return new Date(ms + REGRAS.FUSO_HORAS * 3600000).getUTCHours();
  }

  function resumoVazio() {
    return {
      pontosTotal: 0, dia: null, pontosHoje: 0, viagensPontuadasHoje: 0,
      reputacao: 0.5, viagensValidadas: 0, linhas: [], segundos: 0, dias: [],
      maxJuntos: 0, madrugador: false, conquistas: []
    };
  }

  function nivelDe(pontos) {
    var atual = NIVEIS[0];
    NIVEIS.forEach(function (n) { if (pontos >= n.min) atual = n; });
    var proximo = NIVEIS.filter(function (n) { return n.nivel === atual.nivel + 1; })[0] || null;
    return {
      nivel: atual.nivel, nome: atual.nome, min: atual.min, proximo: proximo,
      progresso: proximo ? (pontos - atual.min) / (proximo.min - atual.min) : 1,
      faltam: proximo ? proximo.min - pontos : 0
    };
  }

  // Confiabilidade 0–1: média móvel de "a viagem se confirmou?".
  function atualizarReputacao(rep, validada) {
    return Math.round((validada ? rep + 0.2 * (1 - rep) : rep - 0.1 * rep) * 1000) / 1000;
  }

  function copiar(x) { return JSON.parse(JSON.stringify(x)); }

  function pontuarViagem(viagem, resumoAnterior) {
    var r = copiar(resumoAnterior || resumoVazio());
    var hoje = dia(viagem.encerradaEm);
    if (r.dia !== hoje) { r.dia = hoje; r.pontosHoje = 0; r.viagensPontuadasHoje = 0; }
    var duracao = viagem.encerradaEm - viagem.iniciadaEm;

    if (!viagem.validada) {
      if (duracao >= REGRAS.DURACAO_MIN_PENALIDADE_MS) r.reputacao = atualizarReputacao(r.reputacao, false);
      return { itens: [], total: 0, motivo: "nao_validada", conquistasNovas: [], resumo: r };
    }

    var multiplicador = Math.min(1, 0.5 + r.reputacao);
    r.reputacao = atualizarReputacao(r.reputacao, true);
    r.viagensValidadas++;
    r.segundos += viagem.segundosValidos || 0;
    if (r.linhas.indexOf(viagem.linhaId) < 0) r.linhas.push(viagem.linhaId);
    if (r.dias.indexOf(hoje) < 0) r.dias.push(hoje);
    r.maxJuntos = Math.max(r.maxJuntos, viagem.maxJuntos || 0);
    if (hora(viagem.iniciadaEm) < 7) r.madrugador = true;

    var itens = [];
    var motivo = null;
    if (r.viagensPontuadasHoje >= REGRAS.LIMITE_VIAGENS_DIA) {
      motivo = "limite_viagens_dia";
    } else {
      itens.push({ tipo: "viagem_iniciada", pontos: REGRAS.PONTOS_INICIO, descricao: "Começou a compartilhar" });
      itens.push({ tipo: "viagem_validada", pontos: REGRAS.PONTOS_VALIDADA, descricao: "Viagem validada" });
      var contrib = Math.min(REGRAS.MAX_CONTRIBUICAO, Math.floor((viagem.segundosValidos || 0) / REGRAS.SEGUNDOS_POR_PONTO));
      if (contrib > 0) itens.push({ tipo: "contribuicao", pontos: contrib, descricao: Math.round((viagem.segundosValidos || 0) / 60) + " min ajudando" });
      if ((viagem.maxJuntos || 0) >= 2) itens.push({ tipo: "confirmada", pontos: REGRAS.PONTOS_CONFIRMADA, descricao: "Confirmada por outros passageiros" });

      var bruto = itens.reduce(function (s, i) { return s + i.pontos; }, 0);
      var ajustado = Math.round(bruto * multiplicador);
      if (ajustado < bruto) itens.push({ tipo: "ajuste_confiabilidade", pontos: ajustado - bruto, descricao: "Ajuste de confiabilidade" });
      var restante = Math.max(0, REGRAS.LIMITE_PONTOS_DIA - r.pontosHoje);
      if (ajustado > restante) {
        itens.push({ tipo: "limite_diario", pontos: restante - ajustado, descricao: "Limite de pontos do dia" });
        motivo = "limite_pontos_dia";
      }
      r.viagensPontuadasHoje++;
    }

    var total = itens.reduce(function (s, i) { return s + i.pontos; }, 0);
    r.pontosTotal += total;
    r.pontosHoje += total;

    var novas = CONQUISTAS.filter(function (c) { return r.conquistas.indexOf(c.codigo) < 0 && c.teste(r); })
      .map(function (c) { return c.codigo; });
    r.conquistas = r.conquistas.concat(novas);

    return { itens: itens, total: total, motivo: motivo, conquistasNovas: novas, resumo: r };
  }

  return {
    REGRAS: REGRAS,
    NIVEIS: NIVEIS,
    CONQUISTAS: CONQUISTAS.map(function (c) { return { codigo: c.codigo, nome: c.nome, descricao: c.descricao }; }),
    resumoVazio: resumoVazio,
    nivelDe: nivelDe,
    pontuarViagem: pontuarViagem,
    diaDe: dia
  };
});
