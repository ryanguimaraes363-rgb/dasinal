/*
  Estimador colaborativo da posição do ônibus (Dá sinal).

  Recebe as localizações que os passageiros de UMA linha enviaram e devolve
  onde os ônibus dessa linha provavelmente estão, com um nível de confiança.
  Nunca devolve a posição de uma pessoa: só a de um grupo que se comporta
  como um ônibus.

  JavaScript puro, sem dependências e sem acesso a rede ou banco. O mesmo
  arquivo roda:
    - no navegador (modo demonstração): window.DaSinalEstimador
    - no servidor (Edge Function do Supabase / Deno ou Node): globalThis.DaSinalEstimador
      ou require("./estimador.js")

  Ideia central: tudo é medido AO LONGO DA ROTA. Cada localização vira
  "s" (metros percorridos desde o início do trajeto) e cada pessoa ganha uma
  velocidade ao longo da rota. Agrupar pessoas em uma dimensão é simples,
  resiste a curvas e a ruas paralelas e já garante que a posição estimada
  fique em cima do trajeto.

  Uso (a cada ~10 s, por linha):

    var rota = DaSinalEstimador.prepararRota(pontosDaRota, { circular: true, paradas: [[lat,lng], ...] });
    var r = DaSinalEstimador.estimar({
      rota: rota,
      amostras: [{ viagem_id, lat, lng, precisao, velocidade, direcao, t }, ...],  // t em ms
      agora: Date.now(),
      estado: rAnterior ? rAnterior.estado : null,   // memória entre ciclos (JSON)
      config: { ... }                                 // opcional: sobrescreve PADRAO
    });
    r.onibus        -> [{ id, lat, lng, s, sentido, velocidade, direcao, confianca, score, qtdPassageiros, ... }]
    r.indisponivel  -> true quando não há estimativa confiável (o app mostra a mensagem)
    r.viagens       -> por viagem: score, onibusId, validada, sugerirFim ...
    r.estado        -> guarde e devolva no próximo ciclo
*/
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === "object" && module.exports) module.exports = api;
  raiz.DaSinalEstimador = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Todos os limites ajustáveis. Tempos em ms, distâncias em metros, velocidades em m/s.
  var PADRAO = {
    JANELA_MS: 180000,            // histórico de amostras analisado por ciclo
    IDADE_MAX_MS: 60000,          // amostra mais nova de uma pessoa precisa ser mais recente que isso
    JANELA_VEL_MS: 30000,         // janela para calcular a velocidade ao longo da rota
    PRECISAO_MAX_M: 100,          // pior precisão de GPS aceita
    DIST_ROTA_MAX_M: 60,          // distância máxima da rota (mais metade da precisão, até 100 m)
    VEL_MAX_MS: 25,               // 90 km/h: acima disso não é ônibus urbano
    VEL_ONIBUS_MS: 5,             // 18 km/h: já andou como veículo
    VEL_PE_MS: 2.5,               // abaixo disso o tempo todo: provavelmente a pé ou parado
    DIR_MAX_GRAUS: 60,            // diferença máxima entre a direção do celular e a da rota

    GRUPO_GAP_M: 40,              // distância máxima entre duas pessoas vizinhas do mesmo ônibus
    GRUPO_SPAN_M: 60,             // comprimento máximo de um grupo
    GRUPO_DV_MS: 3,               // diferença máxima de velocidade dentro do grupo
    TRAJETORIA_MAX_M: 50,         // distância média máxima entre as trajetórias recentes

    EXTRAPOLAR_MAX_S: 30,         // quanto a posição pode ser projetada para "agora"
    CONTINUIDADE_M: 150,          // para reconhecer o mesmo ônibus no ciclo seguinte
    SUAVIZACAO: 0.6,              // 1 = usa só a medida nova; 0 = só a previsão
    ESTIMATIVA_TTL_MS: 90000,     // sem amostra nova há mais que isso: o ônibus some do mapa

    SCORE_MIN_PARTICIPAR: 0.35,   // confiabilidade mínima da viagem para entrar em um grupo
    SCORE_MIN_SOZINHO: 0.6,       // e para, sozinha, gerar uma estimativa
    SOZINHO_MIN_MS: 120000,       // privacidade: 1 pessoa só aparece após 2 min de viagem
    MIN_PASSAGEIROS_EXIBIR: 1,

    PARADA_MIN_MS: 8000,          // leituras paradas cobrindo pelo menos isso contam como parada
    PARADA_PONTO_M: 40,           // parada a essa distância de um ponto conta como "parou no ponto"

    FIM_INATIVIDADE_MS: 180000,
    FIM_FORA_ROTA_MS: 90000,
    FIM_SEPAROU_M: 300,
    FIM_SEPAROU_MS: 60000,
    FIM_PONTO_FINAL_MS: 120000,
    FIM_TEMPO_MAX_MS: 3 * 3600000,
    VALIDAR_SEGUNDOS: 180,        // contribuição mínima para a viagem ser validada

    ALTA_SCORE: 75, ALTA_MIN: 3,
    MEDIA_SCORE: 45, MEDIA_MIN: 2,
    MARGEM_NIVEL: 5
  };

  // ---------- Geometria ----------

  function rad(g) { return g * Math.PI / 180; }
  function limitar(x, a, b) { return Math.max(a, Math.min(b, x)); }

  // 0 quando x = zero, 1 quando x = cheio (linear, funciona nos dois sentidos).
  function faixa(x, zero, cheio) {
    return limitar((x - zero) / (cheio - zero), 0, 1);
  }

  function distanciaM(a, b) {
    var R = 6371000;
    var dLat = rad(b[0] - a[0]);
    var dLng = rad(b[1] - a[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function rumo(a, b) {
    var y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    var x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
      Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function difAngulo(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Move um ponto alguns metros para norte/leste.
  function deslocar(p, norteM, lesteM) {
    return [p[0] + norteM / 110540, p[1] + lesteM / (111320 * Math.cos(rad(p[0])))];
  }

  // pontos: [[lat,lng],...] do traçado (idealmente o traçado pelas ruas).
  // opcoes.circular: a rota é um looping; opcoes.paradas: [[lat,lng],...] dos pontos de ônibus.
  function prepararRota(pontos, opcoes) {
    opcoes = opcoes || {};
    var acum = [0];
    var total = 0;
    for (var i = 1; i < pontos.length; i++) {
      total += distanciaM(pontos[i - 1], pontos[i]);
      acum.push(total);
    }
    return { pts: pontos, acum: acum, total: total, circular: !!opcoes.circular, paradas: opcoes.paradas || [] };
  }

  function normalizarS(rota, s) {
    if (rota.circular && rota.total > 0) return ((s % rota.total) + rota.total) % rota.total;
    return limitar(s, 0, rota.total);
  }

  // b - a ao longo da rota. Na circular, pelo caminho mais curto (pode passar pela emenda).
  function difS(rota, a, b) {
    var d = b - a;
    if (rota.circular && rota.total > 0) {
      var T = rota.total;
      d = ((d + T / 2) % T + T) % T - T / 2;
    }
    return d;
  }

  function segmentoEm(rota, s) {
    var lo = 1, hi = rota.pts.length - 1;
    while (lo < hi) {
      var meio = (lo + hi) >> 1;
      if (rota.acum[meio] < s) lo = meio + 1; else hi = meio;
    }
    return lo;
  }

  function posicaoEm(rota, s) {
    if (rota.pts.length < 2) return rota.pts[0] || [0, 0];
    s = normalizarS(rota, s);
    var i = segmentoEm(rota, s);
    var d = rota.acum[i] - rota.acum[i - 1];
    var k = d ? (s - rota.acum[i - 1]) / d : 0;
    var a = rota.pts[i - 1], b = rota.pts[i];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  }

  // Direção da rota (graus, 0 = norte) no ponto s.
  function rumoEm(rota, s) {
    if (rota.pts.length < 2) return 0;
    var i = segmentoEm(rota, normalizarS(rota, s));
    // Pula trechos de comprimento zero (pontos repetidos).
    while (i < rota.pts.length - 1 && rota.acum[i] === rota.acum[i - 1]) i++;
    return rumo(rota.pts[i - 1], rota.pts[i]);
  }

  // Encaixa lat/lng na rota: { s, d } (d = distância até a rota).
  // Se a rota passa mais de uma vez perto do mesmo lugar (ida e volta pela
  // mesma avenida, por exemplo), escolhe a passagem:
  //   dica: mais próxima de um "s" esperado (a posição anterior da pessoa);
  //   rumoGps: sem dica, a passagem cuja direção bate com a do celular.
  function projetar(rota, lat, lng, dica, rumoGps) {
    var kx = Math.cos(rad(lat)) * 111320;
    var ky = 110540;
    var candidatos = [];
    var melhor = null;
    for (var i = 1; i < rota.pts.length; i++) {
      var a = rota.pts[i - 1], b = rota.pts[i];
      var ax = (a[1] - lng) * kx, ay = (a[0] - lat) * ky;
      var bx = (b[1] - lng) * kx, by = (b[0] - lat) * ky;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? limitar(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
      var px = ax + t * dx, py = ay + t * dy;
      var c = { d: Math.sqrt(px * px + py * py), s: rota.acum[i - 1] + t * (rota.acum[i] - rota.acum[i - 1]) };
      candidatos.push(c);
      if (!melhor || c.d < melhor.d) melhor = c;
    }
    if (!melhor) return { s: 0, d: Infinity };
    // Passagens plausíveis: quase tão perto quanto a mais próxima.
    var opcoes = candidatos.filter(function (c) { return c.d <= melhor.d + 30; });
    if (opcoes.length === 1) return melhor;
    if (rumoGps != null) {
      var mesmaDirecao = opcoes.filter(function (c) {
        var dr = difAngulo(rumoGps, rumoEm(rota, c.s));
        // Na linha de ida e volta a mesma rua vale nos dois sentidos.
        if (!rota.circular) dr = Math.min(dr, 180 - dr);
        return dr <= 60;
      });
      if (mesmaDirecao.length) opcoes = mesmaDirecao;
    }
    if (dica == null) {
      return opcoes.reduce(function (x, c) { return c.d < x.d ? c : x; });
    }
    return opcoes.reduce(function (x, c) {
      return Math.abs(difS(rota, dica, c.s)) < Math.abs(difS(rota, dica, x.s)) ? c : x;
    });
  }

  // ---------- Estatística ----------

  function medianaPonderada(valores, pesos) {
    var idx = valores.map(function (_, i) { return i; }).sort(function (a, b) { return valores[a] - valores[b]; });
    var total = pesos.reduce(function (x, y) { return x + y; }, 0);
    var acum = 0;
    for (var k = 0; k < idx.length; k++) {
      acum += pesos[idx[k]];
      if (acum >= total / 2) return valores[idx[k]];
    }
    return valores[idx[idx.length - 1]];
  }

  // Inclinação (mínimos quadrados) de y em função de x.
  function inclinacao(xs, ys) {
    var n = xs.length, mx = 0, my = 0, sxy = 0, sxx = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    return sxx ? sxy / sxx : 0;
  }

  // ---------- Trilha de uma viagem ----------
  // Encaixa cada amostra na rota e marca as que não servem (e por quê).
  // O encaixe de cada amostra é guardado (mem.proj) e nunca refeito: a mesma
  // amostra não pode "pular" para outra passagem da rota num ciclo seguinte.

  // Direção do celular para escolher a passagem certa da rota na primeira
  // amostra de alguém: a dela, se estava andando, ou a da próxima amostra
  // (até 60 s depois) em que já estava andando.
  function rumoParaDesempate(amostras, a) {
    for (var i = amostras.indexOf(a); i < amostras.length; i++) {
      var b = amostras[i];
      if (b.t - a.t > 60000) break;
      if (b.direcao != null && b.velocidade != null && b.velocidade >= 3) return b.direcao;
    }
    return null;
  }

  function montarTrilha(rota, amostras, mem, cfg, agora) {
    var trilha = [];
    var anterior = null;
    var vAnterior = 0;   // ritmo ao longo da rota entre as duas últimas amostras válidas (m/s)
    var proj = mem.proj || (mem.proj = {});
    Object.keys(proj).forEach(function (t) { if (Number(t) < agora - cfg.JANELA_MS) delete proj[t]; });
    amostras.forEach(function (a) {
      var r = {
        t: a.t, lat: a.lat, lng: a.lng, precisao: a.precisao,
        gpsV: a.velocidade == null ? null : a.velocidade,
        dir: a.direcao == null ? null : a.direcao,
        valida: false, emRota: null, motivo: null, s: null, su: null, d: null
      };
      if (a.t > agora + 5000) r.motivo = "horario_futuro";
      else if (!(a.precisao <= cfg.PRECISAO_MAX_M)) r.motivo = "precisao_baixa";
      else if (r.gpsV != null && r.gpsV > cfg.VEL_MAX_MS) r.motivo = "velocidade_impossivel";
      else {
        var p = proj[a.t];
        if (p) p = { s: p[0], d: p[1] };
        else {
          // Referência: onde a pessoa deveria estar agora, seguindo no ritmo
          // em que vinha (resolve ruas em que o ônibus vai e volta).
          var dica = mem.ultimoS;
          if (anterior) {
            var dtA = Math.min((a.t - anterior.t) / 1000, 60);
            dica = normalizarS(rota, anterior.s + vAnterior * dtA);
          }
          var rumoGps = r.gpsV != null && r.gpsV >= 3 ? r.dir : (dica == null ? rumoParaDesempate(amostras, a) : null);
          p = projetar(rota, a.lat, a.lng, dica, rumoGps);
          proj[a.t] = [Math.round(p.s * 10) / 10, Math.round(p.d * 10) / 10];
        }
        r.s = p.s;
        r.d = p.d;
        r.emRota = p.d <= Math.min(cfg.DIST_ROTA_MAX_M + a.precisao * 0.5, 100);
        if (!r.emRota) r.motivo = "fora_da_rota";
        else if (!anterior) { r.valida = true; r.su = p.s; }
        else {
          var dt = (a.t - anterior.t) / 1000;
          var ds = difS(rota, anterior.s, p.s);
          var folga = 2 * (a.precisao + anterior.precisao);
          if (dt <= 0) r.motivo = "duplicada";
          else if (Math.abs(ds) > folga && Math.abs(ds) / dt > cfg.VEL_MAX_MS) r.motivo = "salto";
          // su: "s" sem a emenda da circular, para calcular velocidade.
          else { r.valida = true; r.su = anterior.su + ds; }
        }
      }
      if (r.valida) {
        if (anterior && r.t > anterior.t) vAnterior = limitar((r.su - anterior.su) / ((r.t - anterior.t) / 1000), -cfg.VEL_MAX_MS, cfg.VEL_MAX_MS);
        else if (rota.circular && r.gpsV != null) vAnterior = r.gpsV;
        anterior = r;
      }
      trilha.push(r);
    });
    return trilha;
  }

  function pertoDeParada(rota, lat, lng, cfg) {
    for (var i = 0; i < rota.paradas.length; i++) {
      if (distanciaM([lat, lng], rota.paradas[i]) <= cfg.PARADA_PONTO_M) return true;
    }
    return false;
  }

  // Atualiza o que a viagem acumula entre ciclos, usando só as amostras novas.
  function atualizarMemoria(mem, trilha, rota, cfg) {
    trilha.forEach(function (r) {
      if (r.t <= mem.ultimoT) return;
      mem.ultimoT = r.t;
      mem.ultimaAmostraT = r.t;
      if (r.emRota === false && mem.foraDesde == null) mem.foraDesde = r.t;
      else if (r.emRota === true) mem.foraDesde = null;
      if (!r.valida) return;

      var vInst = r.gpsV;
      var limiar = 1;
      if (vInst == null && mem.ultimoSt != null && r.t > mem.ultimoSt) {
        var ds = difS(rota, mem.ultimoS, r.s);
        vInst = Math.abs(ds) / ((r.t - mem.ultimoSt) / 1000);
        limiar = 1.5; // velocidade calculada entre dois pontos tem mais ruído
      }
      if (mem.ultimoS != null) mem.distAcum += Math.abs(difS(rota, mem.ultimoS, r.s));

      // Parada = pelo menos duas leituras seguidas paradas (uma só pode ser ruído do GPS).
      if (vInst != null && vInst < limiar) {
        if (!mem.parada) mem.parada = { desde: r.t, ate: r.t, lat: r.lat, lng: r.lng };
        else mem.parada.ate = r.t;
      } else if (vInst != null && mem.parada) {
        if (mem.parada.ate - mem.parada.desde >= cfg.PARADA_MIN_MS) {
          mem.paradas++;
          if (pertoDeParada(rota, mem.parada.lat, mem.parada.lng, cfg)) mem.paradasEmPonto++;
        }
        mem.parada = null;
      }
      mem.ultimoS = r.s;
      mem.ultimoSt = r.t;
    });
  }

  function novaMemoria(t) {
    return {
      inicio: t, ultimoT: 0, ultimaAmostraT: t, ultimoS: null, ultimoSt: null,
      sentido: 0, score: null, andou: false, paradas: 0, paradasEmPonto: 0, parada: null,
      distAcum: 0, foraDesde: null, onibusId: null, segundosValidos: 0, validada: false, fim: null, maxJuntos: 0
    };
  }

  // Estado atual de uma viagem: posição e velocidade ao longo da rota, sentido,
  // peso e a nota de confiabilidade (0–1) que diz se ela parece estar num ônibus.
  function analisarViagem(id, trilha, mem, rota, cfg, agora) {
    var validas = trilha.filter(function (r) { return r.valida; });
    var info = { id: id, trilha: trilha, validas: validas, mem: mem, participa: false };
    var ult = validas[validas.length - 1];
    if (!ult) return info;

    // Velocidade ao longo da rota (com sinal) nos últimos segundos.
    var recentes = validas.filter(function (r) { return r.t >= ult.t - cfg.JANELA_VEL_MS; });
    var v = 0;
    if (recentes.length >= 2 && ult.t - recentes[0].t >= 5000) {
      v = inclinacao(recentes.map(function (r) { return r.t / 1000; }), recentes.map(function (r) { return r.su; }));
    } else if (ult.gpsV != null) {
      v = ult.gpsV * (rota.circular ? 1 : mem.sentido);
    }

    var sentido;
    if (rota.circular) sentido = 1;
    else if (Math.abs(v) >= 1) sentido = v > 0 ? 1 : -1;
    else sentido = mem.sentido;
    mem.sentido = sentido;

    var idade = agora - ult.t;
    var s = normalizarS(rota, ult.s + v * Math.min(idade / 1000, cfg.EXTRAPOLAR_MAX_S));

    // Está na rota agora? (última amostra que deu para encaixar)
    var ultimaComRota = null;
    for (var k = trilha.length - 1; k >= 0; k--) { if (trilha[k].emRota !== null) { ultimaComRota = trilha[k]; break; } }
    var emRotaAgora = !!ultimaComRota && ultimaComRota.emRota;

    // 1) Fração das amostras em cima da rota.
    var comRota = trilha.filter(function (r) { return r.emRota !== null; });
    var fracEmRota = comRota.length ? comRota.filter(function (r) { return r.emRota; }).length / comRota.length : 0;

    // 2) Direção do celular compatível com a da rota (quando anda rápido o suficiente).
    var checadas = 0, coerentes = 0;
    validas.forEach(function (r) {
      if (r.dir == null || r.gpsV == null || r.gpsV < 3) return;
      var esperado = rumoEm(rota, r.s);
      var dif = sentido === -1 ? difAngulo(r.dir, esperado + 180)
        : sentido === 1 ? difAngulo(r.dir, esperado)
        : Math.min(difAngulo(r.dir, esperado), difAngulo(r.dir, esperado + 180));
      checadas++;
      if (dif <= cfg.DIR_MAX_GRAUS) coerentes++;
    });
    var dirComp = checadas ? coerentes / checadas : 0.7;
    if (rota.circular && v < -1) dirComp = 0; // andando na contramão do looping

    // 3) Já andou como veículo? Usa a velocidade do GPS quando o celular informa
    // (é medida, não calculada); senão, o deslocamento em janelas de 20 s.
    // Precisa de pelo menos duas leituras rápidas: um salto de GPS não basta.
    var maxV = 0, rapidas = 0;
    for (var j = 0; j < validas.length; j++) {
      var vj = null;
      if (validas[j].gpsV != null) vj = validas[j].gpsV;
      else {
        for (var i = j - 1; i >= 0; i--) {
          var dt = (validas[j].t - validas[i].t) / 1000;
          if (dt >= 20) { vj = Math.abs(validas[j].su - validas[i].su) / dt; break; }
        }
      }
      if (vj == null) continue;
      maxV = Math.max(maxV, vj);
      if (vj >= cfg.VEL_ONIBUS_MS) rapidas++;
    }
    if (rapidas >= 2) mem.andou = true;
    var mov = mem.andou ? 1 : (agora - mem.inicio >= 120000 && maxV < cfg.VEL_PE_MS) ? 0.1 : 0.5;

    // 4) Padrão de paradas: ônibus para nos pontos; carro para em qualquer lugar (ou nunca).
    var par;
    if (mem.paradas >= 2) par = faixa(mem.paradasEmPonto / mem.paradas, 0, 0.5);
    else if (mem.distAcum > 1000 && mem.paradas === 0) par = 0.2;
    else par = 0.5;

    var novo = 0.35 * fracEmRota + 0.15 * dirComp + 0.25 * mov + 0.25 * par;
    mem.score = mem.score == null ? novo : 0.6 * mem.score + 0.4 * novo;

    info.ult = ult;
    info.s = s;
    info.v = v;
    info.sentido = sentido;
    info.idade = idade;
    info.d = ult.d;
    info.precisao = ult.precisao;
    info.emRota = emRotaAgora;
    // Quanto a posição foi projetada para "agora": é incerteza (o ônibus pode ter parado).
    info.extrap = Math.abs(v) * Math.min(idade / 1000, cfg.EXTRAPOLAR_MAX_S);
    info.w = mem.score * limitar(20 / Math.max(ult.precisao, 1), 0.25, 1) * Math.exp(-idade / 30000) *
      Math.exp(-info.extrap / 50);
    info.participa = !mem.fim && idade <= cfg.IDADE_MAX_MS && emRotaAgora && mem.score >= cfg.SCORE_MIN_PARTICIPAR;
    return info;
  }

  // ---------- Agrupamento ----------

  // "s" (sem emenda) da viagem no instante t, interpolado entre duas amostras próximas.
  function interpolarS(validas, t) {
    for (var i = 1; i < validas.length; i++) {
      var a = validas[i - 1], b = validas[i];
      if (a.t <= t && t <= b.t) {
        if (b.t - a.t > 30000) return null;
        var k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        return a.su + (b.su - a.su) * k;
      }
    }
    return null;
  }

  // As duas pessoas fizeram o mesmo caminho, ao mesmo tempo, nos últimos 2 min?
  // Compara as posições nos MESMOS instantes (sem projetar para "agora").
  // ok: não há sinal de caminhos diferentes; forte: há histórico suficiente
  // mostrando que andaram juntas (vale mais que a velocidade do momento).
  function trajetoriasCompativeis(a, b, rota, cfg) {
    var limite = Math.max(a.ult.t, b.ult.t) - 120000;
    var soma = 0, n = 0, t0 = Infinity, t1 = -Infinity;
    a.validas.forEach(function (ra) {
      if (ra.t < limite) return;
      var sb = interpolarS(b.validas, ra.t);
      if (sb == null) return;
      soma += Math.abs(difS(rota, ra.s, normalizarS(rota, sb)));
      n++;
      t0 = Math.min(t0, ra.t);
      t1 = Math.max(t1, ra.t);
    });
    var ok = n < 2 || soma / n <= cfg.TRAJETORIA_MAX_M;
    return { ok: ok, forte: ok && n >= 3 && t1 - t0 >= 20000 };
  }

  // Incerteza de posição entre duas pessoas, em metros:
  //  - a projeção para "agora" (quem mandou a posição há 10 s andando pode ter
  //    sido projetado além de um ponto em que o ônibus parou);
  //  - a mudança de velocidade que ninguém viu (o ônibus saiu do ponto depois
  //    da última amostra de quem ainda aparece parado).
  function folga(a, b, comMudanca) {
    var f = Math.max(a.extrap, b.extrap);
    if (comMudanca) f += Math.max(a.idade, b.idade) / 1000 * Math.abs(a.v - b.v);
    return f;
  }

  // Duas pessoas podem estar no mesmo ônibus? (distância, velocidade e trajetória)
  function compativeis(a, b, gapMax, rota, cfg) {
    if (Math.abs(difS(rota, a.s, b.s)) > gapMax + folga(a, b, true)) return false;
    var traj = trajetoriasCompativeis(a, b, rota, cfg);
    if (!traj.ok) return false;
    // Sem histórico em comum, só a posição e a velocidade do momento contam.
    if (!traj.forte) {
      return Math.abs(a.v - b.v) <= cfg.GRUPO_DV_MS &&
        Math.abs(difS(rota, a.s, b.s)) <= gapMax + folga(a, b, false);
    }
    return true;
  }

  function adiante(rota, de, para) {
    var d = para - de;
    if (rota.circular) d = ((d % rota.total) + rota.total) % rota.total;
    return d;
  }

  function mediaV(membros) {
    return membros.reduce(function (x, m) { return x + m.v; }, 0) / membros.length;
  }

  // Agrupa pessoas de um mesmo sentido. Percorre a rota em ordem e encaixa
  // cada pessoa no grupo aberto mais compatível: assim um carro que passa
  // no meio de um ônibus não parte o grupo em dois.
  function agruparSentido(lista, sentido, rota, cfg) {
    if (!lista.length) return [];
    lista = lista.slice().sort(function (a, b) { return a.s - b.s; });
    var inicio = 0;
    if (rota.circular && lista.length > 1) {
      // Começa depois do maior vão, para não cortar um grupo na emenda do looping.
      var maiorVao = rota.total - lista[lista.length - 1].s + lista[0].s;
      for (var i = 1; i < lista.length; i++) {
        var vao = lista[i].s - lista[i - 1].s;
        if (vao > maiorVao) { maiorVao = vao; inicio = i; }
      }
    }
    var ordem = lista.slice(inicio).concat(lista.slice(0, inicio));
    var grupos = [];
    ordem.forEach(function (p) {
      var melhor = null, melhorDv = Infinity;
      grupos.forEach(function (g) {
        var primeiro = g.membros[0];
        var ultimo = g.membros[g.membros.length - 1];
        if (adiante(rota, ultimo.s, p.s) > cfg.GRUPO_GAP_M + folga(ultimo, p, true)) return;
        if (adiante(rota, primeiro.s, p.s) > cfg.GRUPO_SPAN_M + folga(primeiro, p, true)) return;
        var dv = Math.abs(p.v - mediaV(g.membros));
        if (dv >= melhorDv) return;
        // Compara com o membro mais próximo em "s".
        var vizinho = g.membros.reduce(function (x, m) {
          return Math.abs(difS(rota, m.s, p.s)) < Math.abs(difS(rota, x.s, p.s)) ? m : x;
        });
        if (!compativeis(vizinho, p, cfg.GRUPO_GAP_M, rota, cfg)) return;
        melhor = g;
        melhorDv = dv;
      });
      if (melhor) melhor.membros.push(p);
      else grupos.push({ sentido: sentido, membros: [p] });
    });
    return grupos;
  }

  function agrupar(participantes, rota, cfg) {
    var grupos = agruparSentido(participantes.filter(function (p) { return p.sentido === 1; }), 1, rota, cfg)
      .concat(agruparSentido(participantes.filter(function (p) { return p.sentido === -1; }), -1, rota, cfg));
    // Sentido ainda desconhecido (ônibus parado desde o embarque): entra no grupo
    // mais próximo, se couber; senão forma grupos próprios.
    var soltos = [];
    participantes.filter(function (p) { return p.sentido === 0; }).forEach(function (p) {
      var melhor = null, melhorD = Infinity;
      grupos.forEach(function (g) {
        var centro = g.membros[Math.floor(g.membros.length / 2)];
        var d = Math.abs(difS(rota, centro.s, p.s));
        if (d < melhorD && compativeis(centro, p, cfg.GRUPO_GAP_M, rota, cfg)) {
          melhor = g;
          melhorD = d;
        }
      });
      if (melhor) melhor.membros.push(p); else soltos.push(p);
    });
    return grupos.concat(agruparSentido(soltos, 0, rota, cfg));
  }

  // Posição e medidas de qualidade de um grupo.
  function resumirGrupo(g, rota) {
    var base = g.membros[0].s;
    var us = g.membros.map(function (m) { return base + difS(rota, base, m.s); });
    var ws = g.membros.map(function (m) { return Math.max(m.w, 1e-6); });
    var somaW = ws.reduce(function (x, y) { return x + y; }, 0);
    var sMed = medianaPonderada(us, ws);
    var v = 0, varS = 0, varV = 0, dSoma = 0, idadeMin = Infinity, ultimaAmostra = 0;
    g.membros.forEach(function (m, i) { v += ws[i] * m.v; });
    v /= somaW;
    g.membros.forEach(function (m, i) {
      varS += ws[i] * (us[i] - sMed) * (us[i] - sMed);
      varV += ws[i] * (m.v - v) * (m.v - v);
      dSoma += m.d;
      idadeMin = Math.min(idadeMin, m.idade);
      ultimaAmostra = Math.max(ultimaAmostra, m.ult.t);
    });
    return {
      s: normalizarS(rota, sMed), v: v,
      sigmaS: Math.sqrt(varS / somaW), sigmaV: Math.sqrt(varV / somaW),
      dMedia: dSoma / g.membros.length, idadeMin: idadeMin, ultimaAmostra: ultimaAmostra,
      nEff: g.membros.reduce(function (x, m) { return x + Math.min(m.w, 1); }, 0),
      n: g.membros.length
    };
  }

  // Nota 0–100 da estimativa (explicada no LEIA-ME).
  function pontuar(r, duracaoMs) {
    var sozinho = r.n < 2;
    var pts = 40 * Math.min(r.nEff, 5) / 5 +
      (sozinho ? 10 : 20 * faixa(r.sigmaS, 60, 15)) +
      (sozinho ? 7 : 15 * faixa(r.sigmaV, 3, 0.5)) +
      10 * faixa(r.dMedia, 60, 15) +
      10 * faixa(r.idadeMin / 1000, 60, 15) +
      5 * faixa(duracaoMs / 1000, 0, 120);
    return Math.round(pts);
  }

  // anterior: o nível do ciclo passado. Para subir de nível a nota precisa
  // atingir o limite; para cair, ficar MARGEM_NIVEL abaixo dele. Assim o selo
  // não fica piscando quando a nota oscila perto do limite.
  function classificar(score, n, cfg, anterior) {
    var m = cfg.MARGEM_NIVEL;
    if (n >= cfg.ALTA_MIN && score >= cfg.ALTA_SCORE - (anterior === "alta" ? m : 0)) return "alta";
    if (n >= cfg.MEDIA_MIN && score >= cfg.MEDIA_SCORE - (anterior === "alta" || anterior === "media" ? m : 0)) return "media";
    return "baixa";
  }

  // O grupo tem evidência suficiente para aparecer no mapa?
  function exibivel(g, agora, cfg) {
    if (g.membros.length < cfg.MIN_PASSAGEIROS_EXIBIR) return false;
    // Continua sendo um ônibus que já estava no mapa com estas pessoas.
    if (g.anterior && g.porMembros) return true;
    var algumAndou = g.membros.some(function (m) { return m.mem.andou; });
    var algumParouEmPonto = g.membros.some(function (m) { return m.mem.paradasEmPonto >= 1; });
    if (g.membros.length === 1) {
      var m = g.membros[0].mem;
      return m.score >= cfg.SCORE_MIN_SOZINHO && agora - m.inicio >= cfg.SOZINHO_MIN_MS && m.andou && m.paradasEmPonto >= 1;
    }
    if (g.membros.length === 2) return algumAndou && algumParouEmPonto;
    return algumAndou;
  }

  function previsto(rota, o, agora, cfg) {
    return normalizarS(rota, o.s + o.v * Math.min(Math.max(agora - o.t, 0) / 1000, cfg.EXTRAPOLAR_MAX_S));
  }

  // Liga cada grupo ao ônibus estimado no ciclo anterior (mantém o id e suaviza o movimento).
  function casarComAnteriores(grupos, anteriores, rota, cfg, agora) {
    var usados = {};
    // 1) Pelos passageiros em comum: o id fica com o grupo que tem mais deles.
    var pares = [];
    grupos.forEach(function (g) {
      anteriores.forEach(function (o) {
        var c = g.membros.filter(function (m) { return o.membros.indexOf(m.id) >= 0; }).length;
        if (c) pares.push({ g: g, o: o, c: c });
      });
    });
    pares.sort(function (a, b) { return b.c - a.c || b.g.membros.length - a.g.membros.length; });
    pares.forEach(function (p) {
      if (p.g.anterior || usados[p.o.id]) return;
      p.g.anterior = p.o;
      p.g.porMembros = true;
      usados[p.o.id] = true;
    });
    // 2) Pela posição prevista.
    grupos.forEach(function (g) {
      if (g.anterior) return;
      var melhor = null, melhorD = cfg.CONTINUIDADE_M;
      anteriores.forEach(function (o) {
        if (usados[o.id]) return;
        if (o.sentido && g.sentido && o.sentido !== g.sentido) return;
        var d = Math.abs(difS(rota, previsto(rota, o, agora, cfg), g.r.s));
        if (d <= melhorD) { melhorD = d; melhor = o; }
      });
      if (melhor) { g.anterior = melhor; usados[melhor.id] = true; }
    });
    return usados;
  }

  var contadorIds = 0;
  function idPadrao(agora) {
    contadorIds++;
    return "est-" + agora.toString(36) + "-" + contadorIds.toString(36);
  }

  function mesclar(base, extra) {
    var r = {};
    Object.keys(base).forEach(function (k) { r[k] = base[k]; });
    Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }

  // ---------- Ciclo de estimativa ----------

  function estimar(entrada) {
    var cfg = mesclar(PADRAO, entrada.config);
    var rota = entrada.rota;
    var agora = entrada.agora != null ? entrada.agora : Date.now();
    var estado = entrada.estado ? JSON.parse(JSON.stringify(entrada.estado)) : { t: null, onibus: [], viagens: {} };
    var dtCiclo = estado.t ? limitar((agora - estado.t) / 1000, 0, 30) : 0;
    var diagnostico = { amostras: 0, validas: 0, descartes: {} };

    // Amostras por viagem, só da janela analisada.
    var porViagem = {};
    (entrada.amostras || []).forEach(function (a) {
      if (a.t < agora - cfg.JANELA_MS) return;
      (porViagem[a.viagem_id] = porViagem[a.viagem_id] || []).push(a);
    });

    var infos = {};
    Object.keys(porViagem).forEach(function (id) {
      var lista = porViagem[id].sort(function (a, b) { return a.t - b.t; });
      var mem = estado.viagens[id] || (estado.viagens[id] = novaMemoria(lista[0].t));
      var trilha = montarTrilha(rota, lista, mem, cfg, agora);
      trilha.forEach(function (r) {
        diagnostico.amostras++;
        if (r.valida) diagnostico.validas++;
        else diagnostico.descartes[r.motivo] = (diagnostico.descartes[r.motivo] || 0) + 1;
      });
      atualizarMemoria(mem, trilha, rota, cfg);
      infos[id] = analisarViagem(id, trilha, mem, rota, cfg, agora);
    });

    var participantes = Object.keys(infos).map(function (k) { return infos[k]; }).filter(function (i) { return i.participa; });
    var grupos = agrupar(participantes, rota, cfg);
    grupos.forEach(function (g) { g.r = resumirGrupo(g, rota); });
    casarComAnteriores(grupos, estado.onibus, rota, cfg, agora);

    var novosOnibus = [];
    var saida = [];
    var continuam = {};
    grupos.forEach(function (g) { if (g.anterior && exibivel(g, agora, cfg)) continuam[g.anterior.id] = true; });
    // Grupos que continuam um ônibus anterior primeiro; depois os novos.
    grupos.sort(function (a, b) { return (b.anterior ? 1 : 0) - (a.anterior ? 1 : 0); });
    grupos.forEach(function (g) {
      if (!exibivel(g, agora, cfg)) return;
      // Pedaço que se desgarrou de um ônibus que continua no mapa (ex.: na chegada
      // a um ponto): não vira um segundo ônibus. Se a pessoa realmente desceu,
      // a viagem dela termina por "separou_do_onibus" ou "fora_da_rota".
      if (!g.anterior) {
        var vieramDeOutro = g.membros.filter(function (m) { return m.mem.onibusId && continuam[m.mem.onibusId]; }).length;
        if (vieramDeOutro * 2 >= g.membros.length) {
          g.membros.forEach(function (m) { m.desgarrouDe = m.mem.onibusId; });
          return;
        }
      }
      var o = g.anterior;
      var s = g.r.s;
      if (o) {
        var p = previsto(rota, o, agora, cfg);
        s = normalizarS(rota, p + cfg.SUAVIZACAO * difS(rota, p, g.r.s));
      }
      var primeiroVisto = o ? o.primeiroVistoEm : agora;
      var score = pontuar(g.r, agora - primeiroVisto);
      var confianca = classificar(score, g.r.n, cfg, o ? o.confianca : null);
      var id = o ? o.id : (cfg.gerarId ? cfg.gerarId() : idPadrao(agora));
      var sentido = g.sentido || (o ? o.sentido : 0);
      var membros = g.membros.map(function (m) { return m.id; });

      novosOnibus.push({
        id: id, s: s, v: g.r.v, sentido: sentido, t: agora, ultimaAmostraEm: g.r.ultimaAmostra,
        primeiroVistoEm: primeiroVisto, membros: membros, score: score, confianca: confianca, qtd: g.r.n
      });
      saida.push(formatarOnibus(rota, id, s, g.r.v, sentido, confianca, score, g.r.n, agora, g.r.ultimaAmostra, primeiroVisto, false));
      g.membros.forEach(function (m) { m.noOnibus = id; });
    });

    // Ônibus cujos passageiros pararam de mandar dados: continuam por pouco
    // tempo, como "desatualizados". Se os passageiros continuam ativos (em
    // outro grupo), ele não fica duplicado na tela.
    estado.onibus.forEach(function (o) {
      if (novosOnibus.some(function (n) { return n.id === o.id; })) return;
      if (agora - o.ultimaAmostraEm > cfg.ESTIMATIVA_TTL_MS) return;
      if (o.membros.some(function (id) { return infos[id] && infos[id].participa; })) return;
      novosOnibus.push(o);
      saida.push(formatarOnibus(rota, o.id, previsto(rota, o, agora, cfg), o.v, o.sentido, "baixa",
        Math.round(o.score * 0.5), o.qtd, o.t, o.ultimaAmostraEm, o.primeiroVistoEm, true));
    });

    // ---------- Situação de cada viagem ----------
    var viagens = {};
    var ativos = {};
    saida.forEach(function (o) { if (!o.desatualizado) ativos[o.id] = o; });

    Object.keys(estado.viagens).forEach(function (id) {
      var mem = estado.viagens[id];
      var info = infos[id];
      var fim = mem.fim;

      // Longe do ônibus em que estava: só conta se durar (um GPS ruim não encerra a viagem).
      var longe = !!(info && info.ult && mem.onibusId && ativos[mem.onibusId] && !info.noOnibus &&
        Math.abs(difS(rota, info.s, ativos[mem.onibusId].s)) > cfg.FIM_SEPAROU_M);
      if (!longe) mem.separadoDesde = null;
      else if (mem.separadoDesde == null) mem.separadoDesde = agora;

      if (!fim) {
        if (agora - mem.ultimaAmostraT >= cfg.FIM_INATIVIDADE_MS) fim = "inatividade";
        else if (mem.foraDesde != null && agora - mem.foraDesde >= cfg.FIM_FORA_ROTA_MS) fim = "fora_da_rota";
        else if (agora - mem.inicio >= cfg.FIM_TEMPO_MAX_MS) fim = "tempo_max";
        else if (longe && agora - mem.separadoDesde >= cfg.FIM_SEPAROU_MS) fim = "separou_do_onibus";
        else if (info && info.ult && !rota.circular && mem.parada && agora - mem.parada.desde >= cfg.FIM_PONTO_FINAL_MS &&
          Math.min(info.s, rota.total - info.s) <= 60) fim = "fim_da_linha";
      }

      var contribuiu = !!(info && info.noOnibus);
      // Maior grupo de que a pessoa fez parte (bônus "confirmada por outros passageiros").
      if (contribuiu && ativos[info.noOnibus]) mem.maxJuntos = Math.max(mem.maxJuntos || 0, ativos[info.noOnibus].qtdPassageiros);
      if (contribuiu) mem.segundosValidos += dtCiclo;
      if (!mem.validada && mem.segundosValidos >= cfg.VALIDAR_SEGUNDOS && mem.score >= cfg.SCORE_MIN_SOZINHO) mem.validada = true;
      // Continua lembrando do ônibus em que estava enquanto ele existir, para
      // medir há quanto tempo a pessoa está longe dele.
      if (contribuiu) mem.onibusId = info.noOnibus;
      else if (info && info.desgarrouDe) mem.onibusId = info.desgarrouDe;
      else if (!(mem.onibusId && ativos[mem.onibusId])) mem.onibusId = null;

      viagens[id] = {
        score: Math.round((mem.score || 0) * 100) / 100,
        emRota: info ? !!info.emRota : false,
        participa: info ? info.participa : false,
        onibusId: contribuiu ? info.noOnibus : null,
        segundosValidos: Math.round(mem.segundosValidos),
        maxJuntos: mem.maxJuntos || 0,
        validada: mem.validada,
        sugerirFim: fim || null
      };

      if (fim) {
        mem.fim = fim;
        // Some da memória quando para de mandar dados.
        if (agora - mem.ultimaAmostraT >= cfg.FIM_INATIVIDADE_MS) delete estado.viagens[id];
      }
    });

    estado.t = agora;
    estado.onibus = novosOnibus;
    return {
      onibus: saida,
      indisponivel: saida.length === 0,
      viagens: viagens,
      diagnostico: diagnostico,
      estado: estado
    };
  }

  function formatarOnibus(rota, id, s, v, sentido, confianca, score, n, atualizadoEm, ultimaAmostraEm, primeiroVistoEm, desatualizado) {
    var pos = posicaoEm(rota, s);
    var direcao = rumoEm(rota, s);
    if (sentido === -1) direcao = (direcao + 180) % 360;
    return {
      id: id, lat: pos[0], lng: pos[1], s: Math.round(s),
      sentido: sentido === 1 ? "ida" : sentido === -1 ? "volta" : null,
      velocidade: Math.round(Math.abs(v) * 10) / 10,
      direcao: Math.round(direcao),
      confianca: confianca, score: score, qtdPassageiros: n,
      atualizadoEm: atualizadoEm, ultimaAmostraEm: ultimaAmostraEm, primeiroVistoEm: primeiroVistoEm,
      desatualizado: desatualizado
    };
  }

  return {
    PADRAO: PADRAO,
    prepararRota: prepararRota,
    estimar: estimar,
    util: {
      distanciaM: distanciaM, rumo: rumo, difAngulo: difAngulo, deslocar: deslocar,
      normalizarS: normalizarS, difS: difS, posicaoEm: posicaoEm, rumoEm: rumoEm, projetar: projetar
    }
  };
});
