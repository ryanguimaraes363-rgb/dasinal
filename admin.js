/*
  Dá sinal · painel administrativo

  Mostra só NÚMEROS AGREGADOS e a posição ESTIMADA dos ônibus. Nenhuma
  localização individual chega a este painel.

    - demonstração: números fictícios gerados neste navegador ("Gerar dados de
      exemplo") e o "agora" + mapa vindos dos passageiros simulados;
    - Supabase: login de administrador (tabela admins) e a função admin_painel
      (supabase/migracoes/005_painel_admin.sql).
*/
(function () {
  "use strict";

  var S = window.DaSinal;
  var CFG = S.config;
  var C = window.DaSinalColaborativo;
  var client = S.client;
  var noServidor = S.modo === "supabase" && !!client;
  var CHAVE_DEMO = "dasinal.demo.painel.v1";
  var ROTULO_CONF = { alta: "Alta", media: "Média", baixa: "Baixa" };
  var ROTULO_TIPO = {
    acesso: "Acessos", consulta_linha: "Consultas de linha", ponto_selecionado: "Pontos selecionados",
    interacao_linha: "Toques no ônibus", localizacao_permitida: "Localização permitida", localizacao_negada: "Localização negada"
  };

  // Mesma ordem e nomes de avisos.js.
  var ROTULO_AVISO = {
    atrasado: "Atrasado", nao_passou: "Não passou", lotado: "Lotado", defeito: "Ônibus com defeito",
    transito: "Acidente ou trânsito", ponto: "Problema no ponto", outro: "Outro problema"
  };
  var CHAVE_AVISOS_APP = "dasinal.avisos.v1";

  var estado = { dias: 30, dados: null, avisos: null, linhas: [], graficos: {}, mapa: null, marcadores: {}, timer: null };
  var fmt = new Intl.NumberFormat("pt-BR");

  // ---------- Utilidades ----------

  function $(s) { return document.querySelector(s); }

  function el(tag, atributos) {
    var no = document.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      if (k === "class") no.className = atributos[k];
      else if (k === "text") no.textContent = atributos[k];
      else no.setAttribute(k, atributos[k]);
    });
    for (var i = 2; i < arguments.length; i++) { if (arguments[i] != null) no.append(arguments[i]); }
    return no;
  }

  function num(n) { return n == null || isNaN(n) ? "—" : fmt.format(n); }
  function pct(a, b) { return b ? Math.round(100 * a / b) + "%" : "—"; }
  function soma(lista, campo) { return lista.reduce(function (s, x) { return s + (x[campo] || 0); }, 0); }
  function diaISO(ms) { return new Date(ms - 3 * 3600000).toISOString().slice(0, 10); }
  function diaCurto(iso) { var p = iso.split("-"); return p[2] + "/" + p[1]; }
  function horaAgora() { return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function token(nome) { return getComputedStyle(document.documentElement).getPropertyValue(nome).trim(); }

  // Texto legível sobre uma cor de fundo (preto ou branco).
  function textoSobre(hex) {
    var h = hex.replace("#", "");
    var rgb = [0, 2, 4].map(function (i) {
      var c = parseInt(h.substr(i, 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 0.35 ? "#0b1220" : "#ffffff";
  }

  function tabela(cabecalhos, linhas, numericas) {
    numericas = numericas || [];
    var t = el("table");
    var tr = el("tr");
    cabecalhos.forEach(function (c, i) { tr.append(el("th", { text: c, class: numericas.indexOf(i) >= 0 ? "num" : "", scope: "col" })); });
    t.append(el("thead", {}, tr));
    var corpo = el("tbody");
    linhas.forEach(function (l) {
      var r = el("tr");
      l.forEach(function (v, i) { r.append(el("td", { text: v, class: numericas.indexOf(i) >= 0 ? "num" : "" })); });
      corpo.append(r);
    });
    t.append(corpo);
    return t;
  }

  function tile(rotulo, valor, detalhe) {
    return el("div", { class: "tile" }, el("small", { text: rotulo }), el("strong", { text: valor }), detalhe ? el("span", { text: detalhe }) : null);
  }

  // ---------- Dados de demonstração (fictícios) ----------

  function gerador(semente) {
    var a = semente | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gerarDemo() {
    var rnd = gerador(20260923);
    var hoje = Date.now();
    var dias = [];
    for (var i = 89; i >= 0; i--) {
      var ms = hoje - i * 86400000;
      var semana = new Date(ms - 3 * 3600000).getUTCDay();
      var fator = semana === 0 ? 0.45 : semana === 6 ? 0.7 : 1;
      var crescimento = 0.5 + 0.5 * (89 - i) / 89;
      var usuarios = Math.round((18 + 34 * crescimento) * fator * (0.85 + 0.3 * rnd()));
      var viagens = Math.round(usuarios * (1.5 + 0.4 * rnd()));
      var onibus = Math.max(1, Math.round(viagens / (2.4 + 0.8 * rnd())));
      var minutos = Math.round(onibus * (18 + 10 * rnd()));
      var alta = Math.round(minutos * (0.38 + 0.14 * rnd()));
      var media = Math.round(minutos * (0.28 + 0.1 * rnd()));
      dias.push({
        dia: diaISO(ms), usuarios: usuarios, viagens: viagens,
        validadas: Math.round(viagens * (0.62 + 0.15 * rnd())),
        localizacoes: viagens * Math.round(45 + 30 * rnd()),
        onibus: onibus, minutos: minutos,
        alta: alta, media: media, baixa: Math.max(0, minutos - alta - media),
        passageiros: Math.round(minutos * (2.2 + 0.8 * rnd())),
        novos: Math.round(usuarios * (0.08 + 0.08 * rnd()))
      });
    }
    return { geradoEm: hoje, base: 120, dias: dias };
  }

  function lerDemo() {
    try { return JSON.parse(window.localStorage.getItem(CHAVE_DEMO) || "null"); } catch (e) { return null; }
  }

  function demandaDe(eventos, linhas) {
    var ag = S.agregar(eventos, linhas, window.DASINAL_DEMO.pontos || []);
    var tipos = {};
    eventos.forEach(function (e) { tipos[e.tipo_interacao] = (tipos[e.tipo_interacao] || 0) + 1; });
    return {
      tipos: tipos,
      horas: ag.horas,
      linhas: ag.linhas.map(function (l) { return { numero: l.numero, nome: l.nome, consultas: l.consultas }; }),
      regioes: ag.regioes.slice(0, 10).map(function (r) { return { regiao: r.regiao_aprox, eventos: r.eventos }; })
    };
  }

  function dadosDemo(dias) {
    var salvo = lerDemo();
    var hoje = Date.now();
    var inicio = diaISO(hoje - (dias - 1) * 86400000);
    var linhas = estado.linhas;
    var eventos = S.eventos.lerDemo().filter(function (e) { return diaISO(Date.parse(e.data_hora)) >= inicio; });

    var porDiaSalvo = {};
    (salvo ? salvo.dias : []).forEach(function (d) { porDiaSalvo[d.dia] = d; });
    var fatia = [];
    for (var i = dias - 1; i >= 0; i--) {
      var dia = diaISO(hoje - i * 86400000);
      fatia.push(porDiaSalvo[dia] || { dia: dia, usuarios: 0, viagens: 0, validadas: 0, localizacoes: 0, onibus: 0, minutos: 0, alta: 0, media: 0, baixa: 0, passageiros: 0 });
    }
    var viagens = soma(fatia, "viagens");
    var validadas = soma(fatia, "validadas");
    var minutos = soma(fatia, "minutos");
    var mediaPass = minutos ? Math.round(10 * soma(fatia, "passageiros") / minutos) / 10 : null;
    var maxDia = fatia.reduce(function (m, d) { return Math.max(m, d.usuarios); }, 0);

    return {
      dias: dias,
      usuariosCadastrados: salvo ? salvo.base + soma(salvo.dias, "novos") : 0,
      usuariosAtivos: Math.max(maxDia, Math.round(soma(fatia, "usuarios") * 0.3)),
      viagens: viagens,
      viagensValidadas: validadas,
      linhasMonitoradas: viagens ? linhas.length : 0,
      localizacoes: soma(fatia, "localizacoes"),
      onibusAcompanhados: soma(fatia, "onibus"),
      mediaPassageiros: mediaPass,
      confiabilidade: { alta: soma(fatia, "alta"), media: soma(fatia, "media"), baixa: soma(fatia, "baixa") },
      porDia: fatia.map(function (d) { return { dia: d.dia, usuarios: d.usuarios, viagens: d.viagens, validadas: d.validadas }; }),
      // A demonstração tem uma linha só: todas as viagens fictícias são dela.
      linhas: linhas.map(function (l, i) {
        return { linha_id: l.id, numero: l.numero, nome: l.nome, viagens: i === 0 ? viagens : 0, validadas: i === 0 ? validadas : 0, mediaPassageiros: i === 0 ? mediaPass : null };
      }),
      demanda: demandaDe(eventos, linhas)
    };
  }

  // Avisos da demonstração: os que foram enviados no app neste navegador
  // (mesmo endereço, mesmo armazenamento) + números fictícios do período.
  function lerAvisosApp() {
    try { var d = JSON.parse(window.localStorage.getItem(CHAVE_AVISOS_APP) || "null"); return d && Array.isArray(d.avisos) ? d : null; }
    catch (e) { return null; }
  }

  function avisosDemo(dias) {
    var salvo = lerDemo();
    var app = lerAvisosApp();
    var agora = Date.now();
    var inicio = agora - dias * 86400000;
    var linhaDe = {};
    estado.linhas.forEach(function (l) { linhaDe[l.id] = l; });
    var doApp = (app ? app.avisos : []).filter(function (a) { return a.criadoEm >= inicio; });

    var pesos = { atrasado: 0.3, lotado: 0.27, nao_passou: 0.14, defeito: 0.1, transito: 0.08, ponto: 0.06, outro: 0.05 };
    var formaHora = [0, 0, 0, 0, 1, 3, 8, 10, 6, 3, 2, 3, 4, 3, 2, 2, 4, 8, 10, 7, 3, 2, 1, 0];
    var totalForma = formaHora.reduce(function (s, v) { return s + v; }, 0);
    var ficticios = 0;
    if (salvo) {
      for (var i = dias - 1; i >= 0; i--) {
        var d = salvo.dias.filter(function (x) { return x.dia === diaISO(agora - i * 86400000); })[0];
        if (d) ficticios += Math.round(d.viagens * 0.12);
      }
    }
    var tipos = {};
    Object.keys(pesos).forEach(function (k) { tipos[k] = Math.round(ficticios * pesos[k]); });
    var horas = formaHora.map(function (v) { return Math.round(ficticios * v / totalForma); });
    doApp.forEach(function (a) {
      tipos[a.tipo] = (tipos[a.tipo] || 0) + 1;
      horas[new Date(a.criadoEm - 3 * 3600000).getUTCHours()]++;
    });
    var total = Object.keys(tipos).reduce(function (s, k) { return s + tipos[k]; }, 0);
    var confirmados = Math.round(ficticios * 0.55) + doApp.filter(function (a) { return a.confirmacoes >= 2; }).length;

    return {
      total: total,
      confirmados: confirmados,
      noOnibus: Math.round(ficticios * 0.4) + doApp.filter(function (a) { return a.naViagem; }).length,
      ativos: doApp.filter(function (a) { return !a.oculto && a.expiraEm > agora; }).length,
      tipos: tipos,
      horas: horas,
      linhas: total ? estado.linhas.slice(0, 1).map(function (l) {
        return { numero: l.numero, nome: l.nome, avisos: total, confirmados: confirmados, tipoMaisComum: "atrasado" };
      }) : [],
      recentes: doApp.slice().sort(function (a, b) { return b.criadoEm - a.criadoEm; }).slice(0, 50).map(function (a) {
        return {
          id: a.id, linha: (linhaDe[a.linhaId] || {}).numero || String(a.linhaId), tipo: a.tipo, texto: a.texto,
          criado_em: new Date(a.criadoEm).toISOString(), confirmacoes: a.confirmacoes, na_viagem: !!a.naViagem,
          oculto: !!a.oculto, ativo: !a.oculto && a.expiraEm > agora
        };
      })
    };
  }

  function ocultarAvisoDemo(id, oculto) {
    var app = lerAvisosApp();
    if (!app) return Promise.resolve();
    app.avisos.forEach(function (a) { if (a.id === id) a.oculto = oculto; });
    try { window.localStorage.setItem(CHAVE_AVISOS_APP, JSON.stringify(app)); } catch (e) { /* sem armazenamento */ }
    return Promise.resolve();
  }

  // ---------- Carregar e desenhar ----------

  function rpc(nome, args) {
    return client.rpc(nome, args).then(function (r) { if (r.error) throw r.error; return r.data; });
  }

  function carregar(silencioso) {
    var blocos = document.querySelectorAll("section.bloco");
    if (!silencioso && estado.dados) blocos.forEach(function (b) { b.classList.add("carregando"); });
    var promessa = noServidor ? rpc("admin_painel", { p_dias: estado.dias }) : Promise.resolve(dadosDemo(estado.dias));
    // Os avisos vêm à parte: se falharem (ex.: 006 ainda não rodou), o resto do painel continua.
    var avisos = (noServidor ? rpc("admin_avisos", { p_dias: estado.dias }) : Promise.resolve(avisosDemo(estado.dias)))
      .catch(function () { return null; });
    return Promise.all([promessa, avisos]).then(function (r) {
      var d = r[0];
      estado.dados = d;
      estado.avisos = r[1];
      desenharPeriodo();
      desenharAvisos(estado.avisos);
      if (noServidor) desenharAgora(d.agora);
      $("#atualizado").textContent = "Atualizado às " + horaAgora();
    }).catch(function (e) {
      var sem = String((e && e.message) || "").indexOf("sem_permissao") >= 0;
      $("#atualizado").textContent = sem ? "Esta conta não tem permissão para ver os números." : "Não foi possível carregar os números agora.";
    }).then(function () {
      blocos.forEach(function (b) { b.classList.remove("carregando"); });
    });
  }

  function desenharAgora(a) {
    a = a || {};
    $("#tiles-agora").replaceChildren(
      tile("Compartilhando localização", num(a.compartilhando), "viagens ativas nos últimos 2 min"),
      tile("Ônibus estimados agora", num(a.onibusAtivos), "no mapa, com dados recentes"),
      tile("Linhas com ônibus agora", num(a.linhasComOnibus), "de " + num(estado.linhas.length) + " linhas ativas"));
  }

  function atualizarAgora() {
    if (noServidor) { carregar(true); return; }
    C.resumoAgora(estado.linhas).then(desenharAgora);
  }

  function desenharPeriodo() {
    var d = estado.dados;
    $("#periodo-texto").textContent = "últimos " + d.dias + " dias";
    $("#tiles-periodo").replaceChildren(
      tile("Usuários cadastrados", num(d.usuariosCadastrados), "total, desde o início"),
      tile("Usuários ativos", num(d.usuariosAtivos), "compartilharam ao menos uma viagem"),
      tile("Viagens acompanhadas", num(d.viagens), num(d.viagensValidadas) + " validadas (" + pct(d.viagensValidadas, d.viagens) + ")"),
      tile("Linhas monitoradas", num(d.linhasMonitoradas), "com viagens compartilhadas"),
      tile("Localizações recebidas", num(d.localizacoes), "leituras de GPS aceitas e descartadas"),
      tile("Ônibus acompanhados", num(d.onibusAcompanhados), "estimativas distintas de ônibus"),
      tile("Passageiros por ônibus", d.mediaPassageiros == null ? "—" : String(d.mediaPassageiros).replace(".", ","), "média contribuindo ao mesmo tempo"));

    desenharConfiabilidade(d.confiabilidade || {});
    desenharGraficosPeriodo(d);
    desenharDemanda(d.demanda || {});
  }

  // Porcentagens inteiras que somam exatamente 100 (maiores restos).
  function partes(valores) {
    var total = valores.reduce(function (s, v) { return s + v; }, 0);
    if (!total) return valores.map(function () { return 0; });
    var brutos = valores.map(function (v) { return 100 * v / total; });
    var inteiros = brutos.map(Math.floor);
    var falta = 100 - inteiros.reduce(function (s, v) { return s + v; }, 0);
    brutos.map(function (b, i) { return { i: i, resto: b - inteiros[i] }; })
      .sort(function (a, b) { return b.resto - a.resto; })
      .slice(0, falta).forEach(function (x) { inteiros[x.i]++; });
    return inteiros;
  }

  function desenharConfiabilidade(c) {
    var total = (c.alta || 0) + (c.media || 0) + (c.baixa || 0);
    var caixa = $("#confiabilidade");
    if (!total) { caixa.replaceChildren(el("p", { class: "vazio", text: "Nenhuma estimativa no período." })); return; }
    var p3 = partes([c.alta || 0, c.media || 0, c.baixa || 0]);
    var porc = { alta: p3[0] + "%", media: p3[1] + "%", baixa: p3[2] + "%" };
    var barra = el("div", { class: "empilhada", role: "img", "aria-label": "Alta " + porc.alta + ", média " + porc.media + ", baixa " + porc.baixa });
    var legenda = el("div", { class: "legenda" });
    ["alta", "media", "baixa"].forEach(function (k) {
      var v = c[k] || 0;
      if (!v) return;
      var cor = token("--conf-" + k);
      var p = 100 * v / total;
      var seg = el("div", { style: "flex:" + v + " 0 0;background:" + cor + ";color:" + textoSobre(cor), title: ROTULO_CONF[k] + ": " + num(v) + " min (" + porc[k] + ")" });
      // Rótulo dentro do segmento só quando cabe.
      if (p >= 14) seg.textContent = ROTULO_CONF[k] + " " + porc[k];
      barra.append(seg);
    });
    ["alta", "media", "baixa"].forEach(function (k) {
      legenda.append(el("span", {}, el("i", { style: "background:" + token("--conf-" + k) }), ROTULO_CONF[k] + " · " + porc[k]));
    });
    var t = tabela(["Nível", "Minutos", "Parte"], ["alta", "media", "baixa"].map(function (k) {
      return [ROTULO_CONF[k], num(c[k] || 0), porc[k]];
    }), [1, 2]);
    caixa.replaceChildren(barra, legenda,
      el("p", { class: "nota", text: "Alta: 3 ou mais passageiros com trajetórias consistentes. Média: 2 ou mais. Baixa: poucos dados ou pouca consistência." }),
      el("details", { class: "tabela" }, el("summary", { text: "Ver tabela" }), t));
  }

  // ---------- Gráficos (Chart.js) ----------

  function opcoesBase(extra) {
    var t = { texto: token("--texto"), texto2: token("--texto-2"), grade: token("--grade"), eixo: token("--eixo"), sup: token("--superficie") };
    var o = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: t.sup, titleColor: t.texto, bodyColor: t.texto2, borderColor: t.eixo, borderWidth: 1,
          padding: 10, boxPadding: 4, usePointStyle: true,
          titleFont: { weight: "800" }, bodyFont: { weight: "600" }
        }
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.eixo }, ticks: { color: t.texto2, maxRotation: 0, autoSkipPadding: 14 } },
        y: { beginAtZero: true, grid: { color: t.grade }, border: { display: false }, ticks: { color: t.texto2, precision: 0 } }
      }
    };
    return Object.assign(o, extra || {});
  }

  function grafico(id, config) {
    if (!window.Chart) return;
    if (estado.graficos[id]) estado.graficos[id].destroy();
    estado.graficos[id] = new Chart(document.getElementById(id), config);
  }

  function linha(rotulo, dados, cor) {
    return {
      label: rotulo, data: dados, borderColor: cor, backgroundColor: cor, borderWidth: 2, tension: 0.25,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: token("--superficie")
    };
  }

  function barras(rotulo, dados, cor, horizontal) {
    return {
      label: rotulo, data: dados, backgroundColor: cor, borderRadius: 4, borderSkipped: "start",
      categoryPercentage: 0.8, barPercentage: 0.9, maxBarThickness: horizontal ? 18 : 28
    };
  }

  function desenharGraficosPeriodo(d) {
    if (window.Chart) Chart.defaults.font.family = '"Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';
    var s1 = token("--serie-1"), s2 = token("--serie-2");
    var rotulos = d.porDia.map(function (x) { return diaCurto(x.dia); });

    grafico("g-usuarios", { type: "line", data: { labels: rotulos, datasets: [linha("Usuários ativos", d.porDia.map(function (x) { return x.usuarios; }), s1)] }, options: opcoesBase() });
    $("#t-usuarios").replaceChildren(tabela(["Dia", "Usuários ativos"], d.porDia.map(function (x) { return [diaCurto(x.dia), num(x.usuarios)]; }), [1]));

    grafico("g-viagens", {
      type: "line",
      data: { labels: rotulos, datasets: [
        linha("Iniciadas", d.porDia.map(function (x) { return x.viagens; }), s1),
        linha("Validadas", d.porDia.map(function (x) { return x.validadas; }), s2)
      ] },
      options: opcoesBase()
    });
    $("#legenda-viagens").replaceChildren(
      el("span", {}, el("i", { style: "background:" + s1 }), "Iniciadas"),
      el("span", {}, el("i", { style: "background:" + s2 }), "Validadas"));
    $("#t-viagens").replaceChildren(tabela(["Dia", "Iniciadas", "Validadas"], d.porDia.map(function (x) { return [diaCurto(x.dia), num(x.viagens), num(x.validadas)]; }), [1, 2]));

    var linhas = (d.linhas || []).filter(function (l) { return l.viagens > 0; }).slice(0, 10);
    var linhasTabela = tabela(["Linha", "Viagens", "Validadas", "Passageiros por ônibus"], (d.linhas || []).map(function (l) {
      return [l.numero + " · " + l.nome, num(l.viagens), num(l.validadas), l.mediaPassageiros == null ? "—" : String(l.mediaPassageiros).replace(".", ",")];
    }), [1, 2, 3]);
    // Com menos de 3 linhas, um gráfico de barras não acrescenta nada: mostra a tabela.
    var comGrafico = linhas.length >= 3;
    $("#w-linhas").hidden = !comGrafico;
    $("#d-linhas").hidden = !comGrafico;
    if (comGrafico) {
      grafico("g-linhas", {
        type: "bar",
        data: { labels: linhas.map(function (l) { return "Linha " + l.numero; }), datasets: [barras("Viagens", linhas.map(function (l) { return l.viagens; }), s1, true)] },
        options: opcoesBase({ indexAxis: "y", interaction: { mode: "nearest", axis: "y", intersect: false }, scales: {
          x: { beginAtZero: true, grid: { color: token("--grade") }, border: { display: false }, ticks: { color: token("--texto-2"), precision: 0 } },
          y: { grid: { display: false }, border: { color: token("--eixo") }, ticks: { color: token("--texto-2") } } } })
      });
      $("#t-linhas").replaceChildren(linhasTabela);
      $("#t-linhas-aberta").replaceChildren();
    } else {
      $("#t-linhas-aberta").replaceChildren(el("div", { class: "tabela-rolagem" }, linhasTabela));
    }
  }

  function desenharDemanda(dm) {
    var s1 = token("--serie-1");
    var tipos = dm.tipos || {};
    $("#tiles-demanda").replaceChildren(
      tile("Acessos", num(tipos.acesso || 0), "visitas ao app"),
      tile("Consultas de linha", num(tipos.consulta_linha || 0), "linhas abertas no mapa"),
      tile("Localização permitida", num(tipos.localizacao_permitida || 0), "botão “Minha localização”"),
      tile("Localização negada", num(tipos.localizacao_negada || 0), "recusou ou bloqueou"));

    var horas = dm.horas || [];
    grafico("g-horas", {
      type: "bar",
      data: { labels: horas.map(function (_, h) { return h + "h"; }), datasets: [barras("Consultas", horas, s1)] },
      options: opcoesBase({ interaction: { mode: "index", intersect: false } })
    });
    $("#t-horas").replaceChildren(tabela(["Hora", "Consultas"], horas.map(function (v, h) { return [h + "h", num(v)]; }), [1]));

    var chaves = Object.keys(ROTULO_TIPO);
    grafico("g-tipos", {
      type: "bar",
      data: { labels: chaves.map(function (k) { return ROTULO_TIPO[k]; }), datasets: [barras("Eventos", chaves.map(function (k) { return tipos[k] || 0; }), s1, true)] },
      options: opcoesBase({ indexAxis: "y", interaction: { mode: "nearest", axis: "y", intersect: false }, scales: {
        x: { beginAtZero: true, grid: { color: token("--grade") }, border: { display: false }, ticks: { color: token("--texto-2"), precision: 0 } },
        y: { grid: { display: false }, border: { color: token("--eixo") }, ticks: { color: token("--texto-2") } } } })
    });
    $("#t-tipos").replaceChildren(tabela(["Tipo", "Eventos"], chaves.map(function (k) { return [ROTULO_TIPO[k], num(tipos[k] || 0)]; }), [1]));

    var cl = dm.linhas || [];
    $("#t-consultas-linhas").replaceChildren(cl.length
      ? el("div", { class: "tabela-rolagem" }, tabela(["Linha", "Consultas"], cl.map(function (l) { return [l.numero + " · " + l.nome, num(l.consultas)]; }), [1]))
      : el("p", { class: "vazio", text: "Nenhuma consulta no período." }));
    var rg = dm.regioes || [];
    $("#t-regioes").replaceChildren(rg.length
      ? el("div", { class: "tabela-rolagem" }, tabela(["Região (lat, lng)", "Eventos"], rg.map(function (r) { return [r.regiao, num(r.eventos)]; }), [1]))
      : el("p", { class: "vazio", text: "Nenhum evento com região no período." }));
  }

  function barrasHorizontais(rotulos, dados, rotulo) {
    return {
      type: "bar",
      data: { labels: rotulos, datasets: [barras(rotulo, dados, token("--serie-1"), true)] },
      options: opcoesBase({ indexAxis: "y", interaction: { mode: "nearest", axis: "y", intersect: false }, scales: {
        x: { beginAtZero: true, grid: { color: token("--grade") }, border: { display: false }, ticks: { color: token("--texto-2"), precision: 0 } },
        y: { grid: { display: false }, border: { color: token("--eixo") }, ticks: { color: token("--texto-2") } } } })
    };
  }

  function dataHoraCurta(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function desenharAvisos(av) {
    if (!av) {
      $("#tiles-avisos").replaceChildren(el("p", { class: "vazio", text: noServidor
        ? "Não foi possível carregar os avisos. Confira se a migração 006_avisos.sql já foi aplicada."
        : "Não foi possível carregar os avisos." }));
      ["#t-avisos-linhas", "#t-avisos-recentes", "#t-avisos-tipos", "#t-avisos-horas"].forEach(function (s) { $(s).replaceChildren(); });
      return;
    }
    $("#tiles-avisos").replaceChildren(
      tile("Avisos no período", num(av.total), "enviados pelos passageiros"),
      tile("Confirmados", num(av.confirmados), pct(av.confirmados, av.total) + " com 2 ou mais confirmações"),
      tile("De dentro do ônibus", num(av.noOnibus), "quem avisou estava compartilhando a viagem"),
      tile("Em vigor agora", num(av.ativos), "aparecendo no app"));

    var chaves = Object.keys(ROTULO_AVISO);
    var tipos = av.tipos || {};
    grafico("g-avisos-tipos", barrasHorizontais(chaves.map(function (k) { return ROTULO_AVISO[k]; }), chaves.map(function (k) { return tipos[k] || 0; }), "Avisos"));
    $("#t-avisos-tipos").replaceChildren(tabela(["Tipo", "Avisos"], chaves.map(function (k) { return [ROTULO_AVISO[k], num(tipos[k] || 0)]; }), [1]));

    var horas = av.horas || [];
    grafico("g-avisos-horas", {
      type: "bar",
      data: { labels: horas.map(function (_, h) { return h + "h"; }), datasets: [barras("Avisos", horas, token("--serie-1"))] },
      options: opcoesBase({ interaction: { mode: "index", intersect: false } })
    });
    $("#t-avisos-horas").replaceChildren(tabela(["Hora", "Avisos"], horas.map(function (v, h) { return [h + "h", num(v)]; }), [1]));

    var ls = av.linhas || [];
    $("#t-avisos-linhas").replaceChildren(ls.length
      ? el("div", { class: "tabela-rolagem" }, tabela(["Linha", "Avisos", "Confirmados", "Mais comum"], ls.map(function (l) {
        return [l.numero + " · " + l.nome, num(l.avisos), num(l.confirmados), ROTULO_AVISO[l.tipoMaisComum] || "—"];
      }), [1, 2]))
      : el("p", { class: "vazio", text: "Nenhum aviso no período." }));

    var rec = av.recentes || [];
    if (!rec.length) {
      $("#t-avisos-recentes").replaceChildren(el("p", { class: "vazio", text: noServidor
        ? "Nenhum aviso no período."
        : "Nenhum aviso enviado neste navegador. No app, abra uma linha e toque em “Avisar problema”." }));
      return;
    }
    var t = tabela(["Quando", "Linha", "Tipo", "Detalhe", "Confirmações", "Situação", ""], [], [4]);
    var corpo = t.querySelector("tbody");
    rec.forEach(function (a) {
      var situacao = a.oculto ? "Oculto" : a.ativo ? "No ar" : "Expirado";
      var b = el("button", { type: "button", class: "btn btn-mini", text: a.oculto ? "Mostrar" : "Ocultar",
        "aria-label": (a.oculto ? "Mostrar de novo" : "Ocultar") + " o aviso " + ROTULO_AVISO[a.tipo] + " da linha " + a.linha });
      b.addEventListener("click", function () {
        b.disabled = true;
        (noServidor ? rpc("admin_ocultar_aviso", { p_aviso_id: a.id, p_oculto: !a.oculto }) : ocultarAvisoDemo(a.id, !a.oculto))
          .then(function () { return carregar(true); }, function () { b.disabled = false; window.alert("Não foi possível mudar este aviso agora."); });
      });
      corpo.append(el("tr", { class: a.oculto ? "oculto" : "" },
        el("td", { text: dataHoraCurta(a.criado_em) }),
        el("td", { text: a.linha }),
        el("td", { text: ROTULO_AVISO[a.tipo] + (a.na_viagem ? " · no ônibus" : "") }),
        el("td", { class: "texto-aviso", text: a.texto || "—" }),
        el("td", { class: "num", text: num(a.confirmacoes) }),
        el("td", {}, el("span", { class: "estado-aviso " + (a.oculto ? "oculto" : a.ativo ? "ativo" : ""), text: situacao })),
        el("td", {}, b)));
    });
    $("#t-avisos-recentes").replaceChildren(t);
  }

  function desenharCadastradas() {
    $("#t-cadastradas").replaceChildren(estado.linhas.length
      ? tabela(["Linha", "Nome", "Origem", "Destino", "Tipo"], estado.linhas.map(function (l) {
        return [l.numero, l.nome, l.origem, l.destino, l.circular ? "Circular" : "Ida e volta"];
      }))
      : el("p", { class: "vazio", text: "Nenhuma linha cadastrada." }));
  }

  // ---------- Mapa (só ônibus estimados) ----------

  function iniciarMapa() {
    if (estado.mapa || !window.L) return;
    var mapa = L.map("mapa-admin").setView(CFG.CENTRO_MAPA, CFG.ZOOM_INICIAL);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(mapa);
    estado.mapa = mapa;
    estado.camadaRotas = L.layerGroup().addTo(mapa);
    estado.camadaOnibus = L.layerGroup().addTo(mapa);
    desenharLegendaMapa();
    var todos = [];
    Promise.all(estado.linhas.map(function (l) {
      return S.dados.obterGeometriaLinha(l).then(function (g) { return { linha: l, pontos: g.pontos && g.pontos.length > 1 ? g.pontos : l.trajeto }; });
    })).then(function (pares) {
      pares.forEach(function (p) {
        if (!p.pontos || p.pontos.length < 2) return;
        L.polyline(p.pontos, { color: S.util.corDaLinha(p.linha), weight: 4, opacity: 0.55 }).addTo(estado.camadaRotas);
        todos = todos.concat(p.pontos);
      });
      if (todos.length) mapa.fitBounds(todos, { padding: [20, 20] });
      pares.forEach(function (p) { C.assinar(p.linha, null, function (pos) { atualizarOnibus(p.linha, pos); }); });
    });
  }

  function desenharLegendaMapa() {
    $("#legenda-mapa").replaceChildren.apply($("#legenda-mapa"), ["alta", "media", "baixa"].map(function (k) {
      return el("span", {}, el("i", { style: "border-radius:50%;background:" + token("--conf-" + k) }), "Confiança " + ROTULO_CONF[k].toLowerCase());
    }));
  }

  function atualizarOnibus(linha, pos) {
    var grupo = estado.marcadores[linha.id] || (estado.marcadores[linha.id] = {});
    var vistos = {};
    (pos.onibus || []).forEach(function (o) {
      vistos[o.id] = true;
      var estilo = { radius: 9, color: token("--superficie"), weight: 2, fillColor: token("--conf-" + o.confianca), fillOpacity: o.desatualizado ? 0.45 : 1 };
      var m = grupo[o.id];
      if (!m) { m = L.circleMarker([o.lat, o.lng], estilo).addTo(estado.camadaOnibus); grupo[o.id] = m; }
      else { m.setLatLng([o.lat, o.lng]); m.setStyle(estilo); }
      m.bindTooltip("Linha " + linha.numero + " · confiança " + ROTULO_CONF[o.confianca].toLowerCase() + " · " +
        o.qtdPassageiros + (o.qtdPassageiros === 1 ? " passageiro" : " passageiros") + (o.desatualizado ? " · sem dados novos" : ""));
    });
    Object.keys(grupo).forEach(function (id) {
      if (vistos[id]) return;
      estado.camadaOnibus.removeLayer(grupo[id]);
      delete grupo[id];
    });
  }

  // ---------- Início, login e filtros ----------

  function abrirPainel(usuario) {
    $("#login").hidden = true;
    $("#painel").hidden = false;
    if (usuario) {
      $("#conta-email").hidden = false;
      $("#conta-email").textContent = usuario.email || "";
      $("#btn-sair").hidden = false;
    }
    S.dados.listarLinhas().then(function (ls) {
      estado.linhas = ls;
      desenharCadastradas();
      desenharAgora({});
      carregar();
      iniciarMapa();
      // Com o Supabase, o "agora" já vem junto com carregar().
      if (!noServidor) atualizarAgora();
      clearInterval(estado.timer);
      estado.timer = setInterval(atualizarAgora, noServidor ? 30000 : 10000);
    }).catch(function () {
      $("#atualizado").textContent = "Não foi possível carregar as linhas.";
    });
  }

  function mostrarLogin(mensagem) {
    $("#painel").hidden = true;
    $("#login").hidden = false;
    $("#btn-sair").hidden = true;
    $("#conta-email").hidden = true;
    $("#login-erro").textContent = mensagem || "";
  }

  function verificarAdmin(usuario) {
    return client.from("admins").select("user_id").eq("user_id", usuario.id).then(function (r) {
      if (r.data && r.data.length) abrirPainel(usuario);
      else mostrarLogin("Esta conta não tem acesso ao painel. Peça para um administrador incluir o seu usuário na tabela admins.");
    }, function () { mostrarLogin("Não foi possível verificar o acesso agora."); });
  }

  document.querySelectorAll(".segmentos button").forEach(function (b) {
    b.addEventListener("click", function () {
      estado.dias = Number(b.getAttribute("data-dias"));
      document.querySelectorAll(".segmentos button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      carregar();
    });
  });
  $("#btn-atualizar").addEventListener("click", function () { carregar(); atualizarAgora(); });

  // Troca claro/escuro: redesenha com as cores do novo tema.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (estado.dados) { desenharPeriodo(); desenharAvisos(estado.avisos); }
      if (estado.mapa) desenharLegendaMapa();
    });
  }

  if (noServidor) {
    $("#chip-modo").textContent = "Conectado";
    $("#form-login").addEventListener("submit", function (e) {
      e.preventDefault();
      $("#login-erro").textContent = "";
      client.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-senha").value }).then(function (r) {
        if (r.error) { $("#login-erro").textContent = "E-mail ou senha incorretos."; return; }
        verificarAdmin(r.data.user);
      });
    });
    $("#btn-sair").addEventListener("click", function () {
      clearInterval(estado.timer);
      client.auth.signOut().then(function () { mostrarLogin(); });
    });
    client.auth.getSession().then(function (r) {
      var sessao = r.data && r.data.session;
      // A sessão anônima de quem compartilha viagens não serve para o painel.
      if (!sessao || sessao.user.is_anonymous) mostrarLogin();
      else verificarAdmin(sessao.user);
    });
  } else {
    $("#btn-gerar").hidden = false;
    $("#btn-limpar").hidden = false;
    $("#aviso-demo").hidden = false;
    $("#btn-gerar").addEventListener("click", function () {
      try { window.localStorage.setItem(CHAVE_DEMO, JSON.stringify(gerarDemo())); } catch (e) { /* sem armazenamento */ }
      S.gerarExemplo(window.DASINAL_DEMO.linhas, window.DASINAL_DEMO.pontos);
      carregar();
    });
    $("#btn-limpar").addEventListener("click", function () {
      try { window.localStorage.removeItem(CHAVE_DEMO); } catch (e) { /* nada */ }
      S.eventos.limparDemo();
      carregar();
    });
    abrirPainel(null);
  }
})();
