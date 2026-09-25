/* Dá sinal · MVP · interface do usuário */
(function () {
  "use strict";

  var S = window.DaSinal;
  var CFG = S.config;
  var I = window.DaSinalIcones;

  var STATUS = { em_movimento: "Em movimento", parado: "Parado", sem_sinal: "Sem sinal" };
  var MSG_INDISPONIVEL = "Localização do ônibus indisponível no momento";
  var ROTULO_CONFIANCA = { alta: "alta", media: "média", baixa: "baixa" };

  // ---------- Utilidades ----------

  function $(seletor) { return document.querySelector(seletor); }

  function el(tag, atributos) {
    var no = document.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      var v = atributos[k];
      if (k === "class") no.className = v;
      else if (k === "text") no.textContent = v;
      else if (k === "html") no.innerHTML = v;
      else no.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i]) no.append(arguments[i]);
    }
    return no;
  }

  // replaceChildren escreveria "null" na tela; ignora os itens vazios.
  function preencher(no) {
    var filhos = Array.prototype.slice.call(arguments, 1).filter(Boolean);
    no.replaceChildren.apply(no, filhos);
  }

  function icone(nome, tam) {
    return el("span", { html: I[nome](tam || 20), "aria-hidden": "true", style: "display:inline-flex" });
  }

  function normalizar(t) {
    return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function horaCompleta(d) {
    return d ? d.toLocaleTimeString("pt-BR", { hour12: false }) : "--:--:--";
  }

  function formatarDistancia(m) {
    if (m < 1000) return m + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }

  // Estimativa de chegada a partir da distância pela rota. Usa, nesta ordem:
  //   1. o ritmo real do ônibus nos últimos minutos (pos.ritmo, com as paradas);
  //   2. a velocidade média da linha, se cadastrada (ex.: intermunicipal);
  //   3. a de um ônibus urbano (config.js).
  // O ritmo tem um piso (11 km/h): ônibus parado no terminal não vira "~90 min".
  function estimarTempo(m, linha, pos) {
    var media = ((linha && Number(linha.velocidade_media_kmh)) || CFG.VELOCIDADE_SIMULADA_KMH || 16) / 3.6;
    var v = pos && pos.ritmo != null ? Math.max(pos.ritmo, 3) : media;
    var s = m / v;
    if (s < 45) return "chegando";
    return "~" + Math.max(1, Math.round(s / 60)) + " min";
  }

  function avisar(texto, alerta) {
    var caixa = $("#avisos");
    var item = el("div", { class: "aviso" + (alerta ? " alerta" : ""), text: texto });
    caixa.append(item);
    setTimeout(function () { item.remove(); }, alerta ? 8000 : 4500);
  }

  function pillStatus(status) {
    var chave = STATUS[status] ? status : "sem_sinal";
    return el("span", { class: "pill " + chave },
      chave === "em_movimento" ? el("i", { class: "ponto-vivo" }) : null,
      STATUS[chave]);
  }

  function badgeLinha(l, mini) {
    return el("span", { class: "badge-linha" + (mini ? " mini" : ""), "aria-hidden": "true" },
      mini ? null : el("small", { text: "LINHA" }), el("b", { text: l.numero }));
  }

  function trajeto(l) {
    return el("span", { class: "trajeto" }, el("span", { text: l.origem }), icone("seta", 14), el("span", { text: l.destino }));
  }

  function injetarIcones(raiz) {
    (raiz || document).querySelectorAll("[data-icone]").forEach(function (no) {
      var fn = I[no.getAttribute("data-icone")];
      if (fn) no.innerHTML = fn(Number(no.getAttribute("data-tam")) || 24);
      no.style.display = "inline-flex";
      no.setAttribute("aria-hidden", "true");
    });
  }

  // Armazenamento local (favoritos e alarme ficam só neste aparelho).
  function lerLocal(chave, padrao) {
    try { var v = window.localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; }
  }
  function gravarLocal(chave, valor) {
    try { window.localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* sem armazenamento */ }
  }

  // ---------- Favoritos ----------

  var favoritos = lerLocal("dasinal.favoritos", []).map(String);

  function ehFavorita(id) { return favoritos.indexOf(String(id)) >= 0; }

  function atualizarBotaoFav(b, linha, claro) {
    var fav = ehFavorita(linha.id);
    b.setAttribute("aria-pressed", String(fav));
    b.setAttribute("aria-label", (fav ? "Remover a linha " : "Favoritar a linha ") + linha.numero);
    b.innerHTML = I[fav ? "coracaoCheio" : "coracao"](22);
    if (claro) b.style.color = fav ? "var(--amarelo)" : "#fff";
  }

  function botaoFavorito(linha, claro) {
    var b = el("button", { type: "button", class: "btn-icone btn-fav" + (claro ? " claro" : ""), "data-fav": linha.id });
    atualizarBotaoFav(b, linha, claro);
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var id = String(linha.id);
      var i = favoritos.indexOf(id);
      if (i >= 0) favoritos.splice(i, 1); else favoritos.push(id);
      gravarLocal("dasinal.favoritos", favoritos);
      document.querySelectorAll('[data-fav="' + id + '"]').forEach(function (outro) {
        atualizarBotaoFav(outro, linha, outro.classList.contains("claro"));
      });
      avisar(i >= 0 ? "Linha " + linha.numero + " removida dos favoritos." : "Linha " + linha.numero + " adicionada aos favoritos.");
      if (telaAtual === "linhas" && filtroLinhas === "favoritas") desenharListaLinhas();
    });
    return b;
  }

  // ---------- Telas ----------

  var telas = {
    home: $("#tela-home"), linhas: $("#tela-linhas"), linha: $("#tela-linha"), mapa: $("#tela-mapa"),
    pontos: $("#tela-pontos"), perfil: $("#tela-perfil"), alarme: $("#tela-alarme"),
    "meus-pontos": $("#tela-meus-pontos"), conta: $("#tela-conta")
  };
  var NAV_DA_TELA = { linha: "linhas", alarme: "perfil", "meus-pontos": "perfil", conta: "perfil" };
  var telaAtual = null;
  var versaoTela = 0;
  var cancelarTela = [];

  function mostrarTela(nome) {
    if (telaAtual === "mapa" && nome !== "mapa") sairDoMapa();
    cancelarTela.forEach(function (fn) { fn(); });
    cancelarTela = [];
    versaoTela++;
    telaAtual = nome;
    Object.keys(telas).forEach(function (k) { telas[k].hidden = k !== nome; });
    var ativa = NAV_DA_TELA[nome] || nome;
    document.querySelectorAll(".nav a[data-tela]").forEach(function (a) {
      if (a.getAttribute("data-tela") === ativa) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    return versaoTela;
  }

  document.querySelectorAll(".js-voltar").forEach(function (b) {
    b.addEventListener("click", function () {
      if (window.history.length > 1) history.back(); else location.hash = "#/";
    });
  });

  var linhasCache = null;
  var statusCache = {};

  function carregarLinhas() {
    if (linhasCache) return Promise.resolve(linhasCache);
    return S.dados.listarLinhas().then(function (l) { linhasCache = l; return l; });
  }

  function acharLinha(linhas, id) {
    return linhas.filter(function (l) { return String(l.id) === String(id); })[0];
  }

  // ---------- Início ----------

  function cardFavorito(l, versao) {
    var cor = S.util.corDaLinha(l);
    var textoProx = el("strong", { text: "Localizando ônibus…" });
    var rotuloProx = el("small", { text: "Próximo ponto do ônibus" });
    var card = el("article", { class: "card-fav", style: "--cor:" + cor },
      el("div", { class: "card-fav-topo" },
        badgeLinha(l),
        el("a", { class: "linha-textos cobrir", href: "#/linha/" + l.id },
          el("strong", { text: l.nome }), trajeto(l), seloAvisos(l)),
        botaoFavorito(l)),
      el("a", { class: "card-fav-prox", href: "#/mapa/" + l.id, "aria-label": "Ver a linha " + l.numero + " no mapa" },
        icone("bus", 24),
        el("span", {}, rotuloProx, textoProx),
        el("span", { class: "chevron" }, icone("avancar", 18))));

    S.dados.listarPontos(l.id).then(function (pontos) {
      if (versao !== versaoTela) return;
      cancelarTela.push(S.posicao.assinar(l, pontos, function (pos) {
        textoProx.classList.toggle("quebra", !!pos.indisponivel);
        if (pos.indisponivel) { rotuloProx.textContent = "Ônibus"; textoProx.textContent = MSG_INDISPONIVEL; return; }
        if (!pos.proximoPonto) { textoProx.textContent = "Sem informação agora"; return; }
        rotuloProx.textContent = pos.status === "parado" ? "Ônibus parado · próximo ponto" : "Próximo ponto do ônibus";
        textoProx.textContent = pos.proximoPonto.nome + " · " + estimarTempo(pos.proximoPonto.distancia, l, pos);
      }));
    }).catch(function () { textoProx.textContent = "Sem informação agora"; });
    return card;
  }

  function abrirHome() {
    var versao = mostrarTela("home");
    Promise.all([carregarLinhas(), S.dados.statusPorLinha().catch(function () { return {}; }), carregarResumoAvisos()]).then(function (r) {
      if (versao !== versaoTela) return;
      var linhas = r[0];
      statusCache = r[1] || {};
      var circulando = Object.keys(statusCache).filter(function (k) { return statusCache[k] !== "sem_sinal"; }).length;
      $("#home-circulando").textContent = circulando === 1 ? "1 linha" : circulando + " linhas";

      var favs = linhas.filter(function (l) { return ehFavorita(l.id); });
      var mostrar = favs.length ? favs : linhas.slice(0, 2);
      $("#home-titulo-lista").textContent = favs.length ? "Linhas favoritas" : "Linhas em destaque";
      $("#home-dica").hidden = favs.length > 0;
      var caixa = $("#home-lista");
      caixa.replaceChildren();
      mostrar.forEach(function (l) { caixa.append(cardFavorito(l, versao)); });
    }).catch(function () {
      $("#home-lista").replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar as linhas. Verifique sua conexão e recarregue a página." }));
    });
  }

  // ---------- Linhas ----------

  var filtroLinhas = "todas";

  function itemLinha(l) {
    var textos = el("a", { class: "linha-textos cobrir", href: "#/linha/" + l.id },
      el("strong", { text: l.nome }), trajeto(l));
    if (statusCache[l.id] || avisosCache[l.id]) {
      textos.append(el("span", { class: "pills" }, statusCache[l.id] ? pillStatus(statusCache[l.id]) : null, seloAvisos(l)));
    }
    return el("article", { class: "item-linha", style: "--cor:" + S.util.corDaLinha(l) },
      badgeLinha(l), textos, botaoFavorito(l), el("span", { class: "chevron" }, icone("avancar", 20)));
  }

  function desenharListaLinhas() {
    var lista = $("#lista-linhas");
    var termo = normalizar($("#busca-linha").value.trim());
    var visiveis = (linhasCache || []).filter(function (l) {
      if (filtroLinhas === "favoritas" && !ehFavorita(l.id)) return false;
      return !termo || normalizar([l.numero, l.nome, l.origem, l.destino].join(" ")).indexOf(termo) >= 0;
    });
    $("#aba-todas").setAttribute("aria-selected", String(filtroLinhas === "todas"));
    $("#aba-favoritas").setAttribute("aria-selected", String(filtroLinhas === "favoritas"));

    if (!visiveis.length) {
      var msg = termo ? "Nenhuma linha encontrada para essa busca."
        : filtroLinhas === "favoritas" ? "Você ainda não tem linhas favoritas. Toque no coração de uma linha para guardá-la aqui."
        : "Nenhuma linha disponível no momento.";
      lista.replaceChildren(el("p", { class: "vazio", text: msg }));
      return;
    }
    lista.replaceChildren.apply(lista, visiveis.map(itemLinha));
  }

  function abrirLinhas(filtro) {
    var versao = mostrarTela("linhas");
    filtroLinhas = filtro === "favoritas" ? "favoritas" : "todas";
    Promise.all([carregarLinhas(), S.dados.statusPorLinha().catch(function () { return {}; }), carregarResumoAvisos()]).then(function (r) {
      if (versao !== versaoTela) return;
      statusCache = r[1] || {};
      desenharListaLinhas();
    }).catch(function () {
      $("#lista-linhas").replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar as linhas. Verifique sua conexão e recarregue a página." }));
    });
  }

  $("#busca-linha").addEventListener("input", desenharListaLinhas);
  $("#aba-todas").addEventListener("click", function () { location.hash = "#/linhas"; });
  $("#aba-favoritas").addEventListener("click", function () { location.hash = "#/linhas/favoritas"; });

  // ---------- Detalhe da linha ----------

  function abrirLinha(id, aba) {
    var versao = mostrarTela("linha");
    var caixa = $("#linha-conteudo");
    caixa.replaceChildren(el("p", { class: "vazio", text: "Carregando…" }));
    $("#linha-fav").replaceChildren();

    carregarLinhas().then(function (linhas) {
      var l = acharLinha(linhas, id);
      if (!l) { avisar("Linha não encontrada."); location.hash = "#/linhas"; return null; }
      $("#linha-titulo").textContent = "Linha " + l.numero;
      $("#linha-sub").textContent = l.nome;
      $("#linha-fav").replaceChildren(botaoFavorito(l, true));
      return S.dados.listarPontos(l.id).then(function (pontos) {
        if (versao !== versaoTela) return;
        montarDetalhe(l, pontos, aba === "sobre" ? "sobre" : "paradas", versao);
      });
    }).catch(function () {
      caixa.replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar a linha. Verifique sua conexão e tente de novo." }));
    });
  }

  function montarDetalhe(l, pontos, abaInicial, versao) {
    var cor = S.util.corDaLinha(l);
    var status = el("span", {}, pillStatus(statusCache[l.id] || "sem_sinal"));
    var agoraTexto = el("strong", { text: "Localizando ônibus…" });
    var agoraRotulo = el("small", { text: "Próximo ponto do ônibus" });

    var resumo = el("div", { class: "card resumo-linha" },
      el("div", { class: "resumo-topo" }, badgeLinha(l),
        el("div", { class: "linha-textos" }, el("strong", { text: l.nome }), trajeto(l), status)),
      el("div", { class: "resumo-agora" }, icone("bus", 24), el("span", {}, agoraRotulo, agoraTexto)),
      el("div", { class: "resumo-acoes" },
        el("a", { class: "btn btn-primario", href: "#/mapa/" + l.id }, icone("mapa", 20), "Ver no mapa"),
        el("a", { class: "btn btn-contorno", href: "#/alarme/" + l.id }, icone("sino", 20), "Criar alarme"),
        S.viagem.disponivel() ? botaoViagem(l, function (c) { cancelarTela.push(c); }) : null));

    var itens = {};
    var ol = el("ol", { class: "paradas", style: "--cor:" + cor });
    pontos.forEach(function (p) {
      var tag = el("span", { class: "tag", hidden: "" });
      var b = el("button", { type: "button", class: "parada" },
        el("span", { class: "parada-ponto" }), el("span", { class: "parada-nome", text: p.nome }), tag);
      b.addEventListener("click", function () { location.hash = "#/mapa/" + l.id + "/" + p.id; });
      itens[p.id] = { botao: b, tag: tag };
      ol.append(el("li", {}, b));
    });

    var sobre = el("dl", { class: "sobre" },
      el("div", {}, el("dt", { text: "Origem" }), el("dd", { text: l.origem })),
      el("div", {}, el("dt", { text: "Destino" }), el("dd", { text: l.destino })),
      el("div", {}, el("dt", { text: "Pontos de parada" }), el("dd", { text: String(pontos.length) })),
      el("div", {}, el("dt", { text: "Posição do ônibus" }), el("dd", {
        text: S.posicao.colaborativa ? "Estimada pelos passageiros" : S.posicao.simulada ? "Simulada (demonstração)" : "Tempo real"
      })));

    var painelParadas = el("div", { class: "card", role: "tabpanel", id: "painel-paradas", "aria-labelledby": "aba-paradas" },
      pontos.length ? ol : el("p", { class: "vazio", style: "padding:1rem", text: "Nenhum ponto cadastrado para esta linha." }));
    var painelSobre = el("div", { class: "card", role: "tabpanel", id: "painel-sobre", "aria-labelledby": "aba-sobre" }, sobre);

    var abaParadas = el("button", { type: "button", role: "tab", id: "aba-paradas", "aria-controls": "painel-paradas", text: "Paradas" });
    var abaSobre = el("button", { type: "button", role: "tab", id: "aba-sobre", "aria-controls": "painel-sobre", text: "Sobre" });
    function escolher(qual) {
      abaParadas.setAttribute("aria-selected", String(qual === "paradas"));
      abaSobre.setAttribute("aria-selected", String(qual === "sobre"));
      painelParadas.hidden = qual !== "paradas";
      painelSobre.hidden = qual !== "sobre";
    }
    abaParadas.addEventListener("click", function () { escolher("paradas"); });
    abaSobre.addEventListener("click", function () { escolher("sobre"); });
    escolher(abaInicial);

    $("#linha-conteudo").replaceChildren(el("div", { class: "detalhe-grade" },
      el("div", { class: "detalhe-coluna" }, resumo, cardAvisos(l, function (c) { cancelarTela.push(c); })),
      el("div", { class: "abas-linha" },
        el("div", { class: "abas", role: "tablist", "aria-label": "Informações da linha" }, abaParadas, abaSobre),
        painelParadas, painelSobre)));

    var anterior = null;
    function limparChegando() {
      if (anterior != null && itens[anterior]) { itens[anterior].botao.classList.remove("chegando"); itens[anterior].tag.hidden = true; }
      anterior = null;
    }

    cancelarTela.push(S.posicao.assinar(l, pontos, function (pos) {
      if (versao !== versaoTela) return;
      status.replaceChildren(pillStatus(pos.status));
      if (pos.indisponivel) {
        agoraRotulo.textContent = "Ônibus";
        agoraTexto.textContent = MSG_INDISPONIVEL;
        limparChegando();
        return;
      }
      if (!pos.proximoPonto) { agoraTexto.textContent = "Sem informação agora"; return; }
      agoraRotulo.textContent = (pos.proximoPonto.aproximado ? "Ponto mais próximo do ônibus" : "Próximo ponto do ônibus") +
        (pos.confianca ? " · confiança " + ROTULO_CONFIANCA[pos.confianca] : "");
      agoraTexto.textContent = pos.proximoPonto.nome + " · " + formatarDistancia(pos.proximoPonto.distancia) + " · " + estimarTempo(pos.proximoPonto.distancia, l, pos);
      if (anterior !== pos.proximoPonto.id) {
        if (anterior != null && itens[anterior]) { itens[anterior].botao.classList.remove("chegando"); itens[anterior].tag.hidden = true; }
        var atual = itens[pos.proximoPonto.id];
        if (atual) { atual.botao.classList.add("chegando"); atual.tag.hidden = false; atual.tag.textContent = "Ônibus chegando"; }
        anterior = pos.proximoPonto.id;
      }
    }));
  }

  // ---------- Mapa ----------

  var mapa = null;
  var camadaRotas = null;
  var camadaPontos = null;
  var camadaOnibus = null;
  var marcadorUsuario = null;
  // marcadoresOnibus[linhaId][onibusId] = marcador. Na posição colaborativa
  // uma linha pode ter vários ônibus (ou nenhum); principalOnibus guarda o
  // de maior confiança, usado pelo botão de centralizar.
  var marcadoresOnibus = {};
  var principalOnibus = {};
  var assinaturas = [];
  var versaoMapa = 0;
  var focoAtual = null;
  var refs = null;

  function iconeOnibus(cor, o) {
    var classes = "mk mk-onibus" + (o && o.confianca ? " conf-" + o.confianca : "") + (o && o.desatualizado ? " desatualizado" : "");
    return L.divIcon({ className: "", iconSize: [40, 40], iconAnchor: [20, 20],
      html: '<span class="' + classes + '" style="--c:' + cor + '">' + I.bus(20) + "</span>" });
  }

  function textoPassageiros(n) {
    return n + (n === 1 ? " passageiro" : " passageiros");
  }

  function popupOnibus(linha, o) {
    var caixa = el("div", {}, el("strong", { text: "Linha " + linha.numero }), el("br"), document.createTextNode(linha.nome));
    if (o && o.confianca) {
      caixa.append(el("br"), el("small", {
        text: "Posição estimada · confiança " + ROTULO_CONFIANCA[o.confianca] + " · " + textoPassageiros(o.qtdPassageiros) +
          (o.desatualizado ? " · sem dados novos" : "")
      }));
    }
    return caixa;
  }
  function iconePonto() {
    return L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: '<span class="mk mk-ponto"></span>' });
  }
  function iconeUsuario() {
    return L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<span class="mk mk-usuario"></span>' });
  }

  function garantirMapa() {
    if (mapa) return true;
    if (!window.L) {
      $("#mapa").replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar o mapa. Verifique sua conexão e recarregue a página." }));
      return false;
    }
    mapa = L.map("mapa", { zoomControl: false }).setView(CFG.CENTRO_MAPA, CFG.ZOOM_INICIAL);
    L.control.zoom({ position: "topleft" }).addTo(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(mapa);
    camadaRotas = L.layerGroup().addTo(mapa);
    camadaPontos = L.layerGroup().addTo(mapa);
    camadaOnibus = L.layerGroup().addTo(mapa);
    return true;
  }

  function limparMapa() {
    assinaturas.forEach(function (cancelar) { cancelar(); });
    assinaturas = [];
    Object.keys(marcadoresOnibus).forEach(function (k) {
      Object.keys(marcadoresOnibus[k]).forEach(function (id) {
        if (marcadoresOnibus[k][id]._anim) cancelAnimationFrame(marcadoresOnibus[k][id]._anim);
      });
    });
    marcadoresOnibus = {};
    principalOnibus = {};
    if (camadaRotas) { camadaRotas.clearLayers(); camadaPontos.clearLayers(); camadaOnibus.clearLayers(); }
    focoAtual = null;
    refs = null;
  }

  // Enquadra a rota deixando livre a área coberta pelo painel
  // (embaixo no celular, à esquerda no computador).
  function enquadrar(pontos) {
    var sheet = $("#sheet");
    var lateral = window.matchMedia("(min-width: 900px)").matches;
    var cima = [40, 40];
    var baixo = [40, 40];
    if (lateral) cima[0] = sheet.offsetWidth + 40;
    else baixo[1] = sheet.offsetHeight + 30;
    mapa.fitBounds(L.latLngBounds(pontos), { paddingTopLeft: cima, paddingBottomRight: baixo });
  }

  function moverMarcador(marcador, para, duracao) {
    if (marcador._anim) cancelAnimationFrame(marcador._anim);
    var de = marcador.getLatLng();
    var t0 = performance.now();
    function passo(t) {
      var k = Math.min(1, (t - t0) / duracao);
      marcador.setLatLng([de.lat + (para[0] - de.lat) * k, de.lng + (para[1] - de.lng) * k]);
      if (k < 1) marcador._anim = requestAnimationFrame(passo);
    }
    marcador._anim = requestAnimationFrame(passo);
  }

  // pontosRota: a geometria a desenhar — o traçado real das ruas quando
  // disponível (ver obterGeometriaLinha), senão o traçado reto da linha.
  function desenharRota(pontosRota, cor) {
    L.polyline(pontosRota, { color: "#FFFFFF", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(camadaRotas);
    L.polyline(pontosRota, { color: cor, weight: 5, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(camadaRotas);
  }

  function desenharExtremos(linha, cor, pontosRota) {
    var pts = pontosRota;
    var extremos = [["Origem", linha.origem, pts[0]]];
    // Na circular o destino é o próprio ponto de partida.
    if (!linha.circular) extremos.push(["Destino", linha.destino, pts[pts.length - 1]]);
    extremos.forEach(function (e) {
      L.circleMarker(e[2], { radius: 8, color: "#FFFFFF", weight: 3, fillColor: cor, fillOpacity: 1 })
        .bindTooltip(e[1], { permanent: true, direction: e[0] === "Origem" ? "top" : "bottom", offset: [0, e[0] === "Origem" ? -8 : 8], className: "rotulo-mapa" })
        .addTo(camadaRotas);
    });
  }

  // ---------- Ônibus deslizando pela rota entre uma atualização e outra ----------
  // A posição chega a cada ~10 s. Entre uma e outra, o marcador segue pela rota
  // na velocidade atual (no máximo 15 s adiante). Se a atualização seguinte vier
  // um pouco atrás de onde o marcador já está, ele não volta: espera o ônibus.
  var DESLIZAR_MAX_S = 15;
  var RECUO_MAX_M = 150;
  var UE = window.DaSinalEstimador && window.DaSinalEstimador.util;

  function sentidoNaRota(o) {
    if (o.rota && o.rota.circular) return 1;
    return o.sentido === "ida" ? 1 : o.sentido === "volta" ? -1 : 0;
  }

  function sExibido(m) {
    var d = m._desliza;
    if (!d) return null;
    var s = d.s + d.v * Math.min((Date.now() - d.t0) / 1000, DESLIZAR_MAX_S);
    return d.rota.circular ? UE.normalizarS(d.rota, s) : Math.max(0, Math.min(d.rota.total, s));
  }

  // Devolve true se o marcador deve ficar onde está (não recuar).
  function prepararDeslize(m, o) {
    var dir = sentidoNaRota(o);
    if (!UE || !o.rota || o.s == null || !dir || o.desatualizado || !(o.velocidade >= 1)) { m._desliza = null; return false; }
    var base = o.s;
    var atual = m._desliza && m._desliza.rota === o.rota ? sExibido(m) : null;
    if (atual != null) {
      var afrente = UE.difS(o.rota, atual, o.s) * dir;
      if (afrente < 0 && afrente > -RECUO_MAX_M) base = atual;
    }
    m._desliza = { rota: o.rota, s: base, v: o.velocidade * dir, t0: Date.now() };
    return true;
  }

  setInterval(function () {
    if (telaAtual !== "mapa" || document.hidden) return;
    Object.keys(marcadoresOnibus).forEach(function (k) {
      Object.keys(marcadoresOnibus[k]).forEach(function (id) {
        var m = marcadoresOnibus[k][id];
        if (m._desliza) moverMarcador(m, UE.posicaoEm(m._desliza.rota, sExibido(m)), 1000);
      });
    });
  }, 1000);

  function aoPosicaoOnibus(linha, cor, pos) {
    // Posição simulada / GPS: um ônibus por linha. Colaborativa: a lista estimada.
    var lista = pos.onibus || (pos.lat != null ? [Object.assign({ id: "_" }, pos)] : []);
    var grupo = marcadoresOnibus[linha.id] || (marcadoresOnibus[linha.id] = {});
    var vistos = {};
    lista.forEach(function (o) {
      vistos[o.id] = true;
      var ll = [o.lat, o.lng];
      var chaveIcone = (o.confianca || "") + (o.desatualizado ? "-d" : "");
      var m = grupo[o.id];
      if (!m) {
        m = L.marker(ll, { icon: iconeOnibus(cor, o), zIndexOffset: 1000, title: "Ônibus da linha " + linha.numero }).addTo(camadaOnibus);
        m.bindPopup(function (camada) { return popupOnibus(linha, camada._dados); });
        m.on("click", function () { S.eventos.registrar({ tipo: "interacao_linha", linha_id: linha.id }); });
        grupo[o.id] = m;
        prepararDeslize(m, o);
      } else {
        // Deslizando: o relógio de 1 s acima leva o marcador; senão, anima até a posição nova.
        if (!prepararDeslize(m, o)) moverMarcador(m, ll, S.posicao.intervaloMs);
        if (m._chaveIcone !== chaveIcone) m.setIcon(iconeOnibus(cor, o));
      }
      m._dados = o;
      m._chaveIcone = chaveIcone;
    });
    // Ônibus que deixaram de ser estimados saem do mapa (não inventamos posição).
    Object.keys(grupo).forEach(function (id) {
      if (vistos[id]) return;
      if (grupo[id]._anim) cancelAnimationFrame(grupo[id]._anim);
      camadaOnibus.removeLayer(grupo[id]);
      delete grupo[id];
    });
    principalOnibus[linha.id] = pos.indisponivel ? null : (pos.id || "_");
    if (focoAtual && String(focoAtual.id) === String(linha.id) && refs) atualizarPainel(pos);
  }

  function atualizarPainel(pos) {
    refs.status.replaceChildren(pillStatus(pos.status));
    refs.proximo.classList.toggle("quebra", !!pos.indisponivel);
    if (pos.indisponivel) {
      refs.hora.textContent = "Ninguém compartilhando esta linha agora";
      refs.rotuloProximo.textContent = "Ônibus";
      refs.proximo.textContent = MSG_INDISPONIVEL;
      refs.distancia.textContent = "";
      refs.tempo.textContent = "";
      refs.confianca.hidden = true;
      return;
    }
    refs.hora.textContent = (pos.desatualizado ? "Sem dados novos desde " : "Atualizado às ") + horaCompleta(pos.atualizadoEm);
    if (pos.confianca) {
      var outros = pos.onibus ? pos.onibus.length - 1 : 0;
      refs.confianca.hidden = false;
      preencher(refs.confianca,
        el("span", { class: "pill conf-" + pos.confianca }, el("i", { class: "conf-barras", "aria-hidden": "true" }),
          "Confiança " + ROTULO_CONFIANCA[pos.confianca]),
        el("span", { text: "Estimada com " + textoPassageiros(pos.qtdPassageiros) }),
        outros > 0 ? el("span", { text: "+ " + outros + (outros === 1 ? " outro ônibus" : " outros ônibus") + " no mapa" }) : null);
    }
    if (pos.proximoPonto) {
      refs.rotuloProximo.textContent = pos.proximoPonto.aproximado ? "Ponto mais próximo" : "Próximo ponto";
      refs.proximo.textContent = pos.proximoPonto.nome;
      refs.distancia.textContent = formatarDistancia(pos.proximoPonto.distancia);
      refs.tempo.textContent = estimarTempo(pos.proximoPonto.distancia, focoAtual, pos);
    } else {
      refs.proximo.textContent = "—";
      refs.distancia.textContent = "";
      refs.tempo.textContent = "";
    }
  }

  function selecionarPonto(linha, ponto, marcadores) {
    if (refs) refs.chips.forEach(function (c) { c.el.setAttribute("aria-pressed", String(c.id === ponto.id)); });
    mapa.setView(marcadores[ponto.id] ? marcadores[ponto.id].getLatLng() : [ponto.latitude, ponto.longitude], Math.max(mapa.getZoom(), 16));
    if (marcadores[ponto.id]) marcadores[ponto.id].openPopup();
    S.eventos.registrar({ tipo: "ponto_selecionado", linha_id: linha.id, ponto_id: ponto.id });
  }

  function atualizarBotoesLoc() {
    var ativa = S.localizacao.ativa();
    var b = $("#btn-loc");
    b.setAttribute("aria-pressed", String(ativa));
    b.setAttribute("aria-label", ativa ? "Parar de compartilhar localização" : "Usar minha localização");
    b.title = b.getAttribute("aria-label");
  }

  function montarSheetLinha(linha, pontos, cor, marcadoresPonto, fonteRota) {
    refs = {
      status: el("span", {}, pillStatus("sem_sinal")),
      hora: el("span", { text: "Atualizado às --:--:--" }),
      rotuloProximo: el("small", { text: "Próximo ponto" }),
      proximo: el("strong", { text: "—" }),
      distancia: el("strong", { text: "—" }),
      tempo: el("small", { text: "" }),
      confianca: el("div", { class: "sheet-confianca", hidden: "" }),
      chips: []
    };

    var lista = el("div", { class: "pontos-lista", id: "sheet-pontos", hidden: "" });
    pontos.forEach(function (p) {
      var chip = el("button", { type: "button", class: "ponto-item", "aria-pressed": "false" }, icone("ponto", 18), p.nome);
      chip.addEventListener("click", function () { selecionarPonto(linha, p, marcadoresPonto); });
      refs.chips.push({ id: p.id, el: chip });
      lista.append(chip);
    });

    var verParadas = el("button", { type: "button", class: "btn btn-primario btn-bloco", "aria-expanded": "false", "aria-controls": "sheet-pontos" });
    function rotuloParadas(aberto) {
      verParadas.replaceChildren(icone("lista", 20), aberto ? "Esconder paradas" : "Ver paradas (" + pontos.length + ")");
    }
    rotuloParadas(false);
    verParadas.addEventListener("click", function () {
      lista.hidden = !lista.hidden;
      verParadas.setAttribute("aria-expanded", String(!lista.hidden));
      rotuloParadas(!lista.hidden);
    });

    preencher($("#sheet"),
      el("div", { class: "sheet-prox" },
        el("span", { class: "sheet-prox-icone" }, icone("bus", 22)),
        el("span", { class: "sheet-prox-texto" }, refs.rotuloProximo, refs.proximo),
        el("span", { class: "sheet-dist" }, refs.distancia, refs.tempo)),
      el("div", { class: "sheet-meta" }, refs.status, refs.hora),
      refs.confianca,
      S.viagem.disponivel() ? el("div", { class: "sheet-viagem" }, botaoViagem(linha, function (c) { assinaturas.push(c); })) : null,
      cardAvisos(linha, function (c) { assinaturas.push(c); }, true),
      verParadas,
      lista,
      notaPosicao(),
      fonteRota === "reta" ? el("p", { class: "nota", text: "Não foi possível calcular o trajeto pelas ruas agora. Mostrando uma linha reta entre os pontos." }) : null);
    return marcadoresPonto;
  }

  function montarSheetGeral(linhas) {
    var chips = el("div", { class: "chips-linhas" });
    linhas.forEach(function (l) {
      chips.append(el("a", { class: "chip-linha", href: "#/mapa/" + l.id, style: "--cor:" + S.util.corDaLinha(l) },
        badgeLinha(l, true), el("strong", { text: l.nome })));
    });
    preencher($("#sheet"),
      el("h2", { text: "Linhas no mapa" }),
      chips,
      notaPosicao());
  }

  function notaPosicao() {
    if (S.posicao.colaborativa) {
      return el("p", { class: "nota", text: "Posição estimada a partir de passageiros que compartilham a viagem. Ninguém vê a localização de outra pessoa." +
        (window.DaSinalColaborativo.simulando() ? " Nesta demonstração, os passageiros são simulados." : "") });
    }
    return S.posicao.simulada ? el("p", { class: "nota", text: "Posição do ônibus simulada para demonstração." }) : null;
  }

  // Marca o ponto de ônibus exatamente sobre a rua desenhada: encontra o
  // ponto da geometria da rua mais próximo do ponto cadastrado e usa essa
  // posição no mapa, em vez das coordenadas originais (que podem cair um
  // pouco ao lado da rua).
  function ancorarNaRua(rotaPreparada, p) {
    if (!rotaPreparada || !rotaPreparada.total) return [p.latitude, p.longitude];
    var s = S.util.projetarNaRota(rotaPreparada, p.latitude, p.longitude);
    return S.util.posicaoEm(rotaPreparada, s);
  }

  function abrirLinhaNoMapa(linha, pontoId, versao) {
    return Promise.all([
      S.dados.listarPontos(linha.id),
      S.dados.obterGeometriaLinha(linha)
    ]).then(function (r) {
      if (versao !== versaoMapa) return;
      var pontos = r[0];
      var geo = r[1];
      var pontosRota = geo.pontos && geo.pontos.length > 1 ? geo.pontos : linha.trajeto;
      var rotaPreparada = S.util.criarRota(pontosRota);
      var cor = S.util.corDaLinha(linha);
      focoAtual = linha;
      desenharRota(pontosRota, cor);
      desenharExtremos(linha, cor, pontosRota);

      var marcadoresPonto = {};
      pontos.forEach(function (p) {
        var m = L.marker(ancorarNaRua(rotaPreparada, p), { icon: iconePonto(), title: p.nome }).addTo(camadaPontos);
        m.bindPopup(el("strong", { text: p.nome }));
        m.on("click", function () { selecionarPonto(linha, p, marcadoresPonto); });
        marcadoresPonto[p.id] = m;
      });

      montarSheetLinha(linha, pontos, cor, marcadoresPonto, geo.fonte);
      if (pontosRota.length > 1) enquadrar(pontosRota);
      S.eventos.registrar({ tipo: "consulta_linha", linha_id: linha.id });
      assinaturas.push(S.posicao.assinar(linha, pontos, function (pos) { aoPosicaoOnibus(linha, cor, pos); }));

      var alvo = pontoId != null && pontos.filter(function (p) { return String(p.id) === String(pontoId); })[0];
      if (alvo) selecionarPonto(linha, alvo, marcadoresPonto);
    });
  }

  function abrirVisaoGeral(linhas, versao) {
    montarSheetGeral(linhas);
    return Promise.all(linhas.map(function (l) {
      return Promise.all([S.dados.listarPontos(l.id), S.dados.obterGeometriaLinha(l)])
        .then(function (r) { return { linha: l, pontos: r[0], geo: r[1] }; });
    })).then(function (pares) {
      if (versao !== versaoMapa) return;
      var todos = [];
      pares.forEach(function (par) {
        var pontosRota = par.geo.pontos && par.geo.pontos.length > 1 ? par.geo.pontos : par.linha.trajeto;
        if (!pontosRota || pontosRota.length < 2) return;
        var cor = S.util.corDaLinha(par.linha);
        desenharRota(pontosRota, cor);
        todos = todos.concat(pontosRota);
        assinaturas.push(S.posicao.assinar(par.linha, par.pontos, function (pos) { aoPosicaoOnibus(par.linha, cor, pos); }));
      });
      if (todos.length) enquadrar(todos);
    });
  }

  function abrirMapa(linhaId, pontoId) {
    mostrarTela("mapa");
    var versao = ++versaoMapa;
    limparMapa();
    atualizarBotoesLoc();
    $("#mapa-voltar").style.visibility = linhaId != null ? "visible" : "hidden";
    $("#mapa-titulo").textContent = "Mapa";
    $("#mapa-sub").textContent = "Ônibus em tempo real";
    $("#btn-centralizar").hidden = linhaId == null;
    if (!garantirMapa()) { $("#sheet").replaceChildren(); return; }
    setTimeout(function () { mapa.invalidateSize(); }, 0);

    carregarLinhas().then(function (linhas) {
      if (versao !== versaoMapa) return null;
      if (linhaId != null) {
        var foco = acharLinha(linhas, linhaId);
        if (!foco) { avisar("Linha não encontrada."); location.hash = "#/linhas"; return null; }
        $("#mapa-titulo").textContent = "Linha " + foco.numero;
        $("#mapa-sub").textContent = foco.origem + " → " + foco.destino;
        return abrirLinhaNoMapa(foco, pontoId, versao);
      }
      return abrirVisaoGeral(linhas, versao);
    }).catch(function () {
      if (versao === versaoMapa) {
        $("#sheet").replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar os dados da linha. Verifique sua conexão e tente de novo." }));
      }
    });
  }

  function sairDoMapa() {
    versaoMapa++;
    limparMapa();
    pararLocalizacao(true);
  }

  $("#btn-centralizar").addEventListener("click", function () {
    var grupo = focoAtual && marcadoresOnibus[focoAtual.id];
    var m = grupo && grupo[principalOnibus[focoAtual.id]];
    if (m) mapa.setView(m.getLatLng(), Math.max(mapa.getZoom(), 16));
    else if (focoAtual) avisar(MSG_INDISPONIVEL + ".");
  });
  $("#btn-loc").addEventListener("click", alternarLocalizacao);

  // ---------- Localização (somente com consentimento) ----------

  var ultimoFocoAntesDoModal = null;

  function abrirModalLocalizacao() {
    ultimoFocoAntesDoModal = document.activeElement;
    $("#modal-loc").hidden = false;
    $("#loc-permitir").focus();
  }

  function fecharModalLocalizacao() {
    $("#modal-loc").hidden = true;
    if (ultimoFocoAntesDoModal && ultimoFocoAntesDoModal.focus) ultimoFocoAntesDoModal.focus();
  }

  function alternarLocalizacao() {
    if (S.localizacao.ativa()) { pararLocalizacao(false); return; }
    if (!S.localizacao.disponivel()) { avisar("Seu navegador não oferece localização. O restante do app continua funcionando."); return; }
    // Se o navegador já tem a permissão, iniciamos direto (a pessoa acabou de tocar no botão).
    S.localizacao.permissaoJaConcedida().then(function (concedida) {
      if (concedida) iniciarLocalizacao(); else abrirModalLocalizacao();
    });
  }

  function iniciarLocalizacao() {
    S.localizacao.iniciar(aoPosicaoUsuario, aoErroLocalizacao);
    atualizarBotoesLoc();
  }

  function pararLocalizacao(silencioso) {
    var estavaAtiva = S.localizacao.ativa();
    S.localizacao.parar();
    if (marcadorUsuario && mapa) { mapa.removeLayer(marcadorUsuario); }
    marcadorUsuario = null;
    atualizarBotoesLoc();
    if (!silencioso && estavaAtiva) avisar("Você parou de compartilhar sua localização.");
  }

  function aoPosicaoUsuario(pos) {
    if (!mapa || !window.L) return;
    if (!marcadorUsuario) {
      marcadorUsuario = L.marker(pos, { icon: iconeUsuario(), zIndexOffset: 900, title: "Você está aqui" }).addTo(mapa);
      marcadorUsuario.bindTooltip("Você está aqui", { permanent: true, direction: "top", offset: [0, -10], className: "rotulo-mapa" });
      mapa.setView(pos, Math.max(mapa.getZoom(), 15));
      avisar("Localização ativada. Seu ponto aparece no mapa só para você.");
    } else {
      marcadorUsuario.setLatLng(pos);
    }
  }

  function aoErroLocalizacao(err) {
    atualizarBotoesLoc();
    if (err && err.code === 1) avisar("A permissão de localização foi negada. O app continua funcionando sem ela.");
    else avisar("Não foi possível obter sua localização agora.");
  }

  $("#loc-permitir").addEventListener("click", function () {
    fecharModalLocalizacao();
    iniciarLocalizacao();
  });
  $("#loc-agora-nao").addEventListener("click", function () {
    fecharModalLocalizacao();
    S.localizacao.recusar();
    avisar("Tudo bem. Você pode ativar a localização depois.");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("#modal-loc").hidden) $("#loc-agora-nao").click();
    if (e.key === "Escape" && !$("#modal-viagem").hidden) $("#viagem-cancelar").click();
    if (e.key === "Escape" && !$("#modal-aviso").hidden) $("#aviso-cancelar").click();
  });

  // ---------- "Estou neste ônibus" (viagem colaborativa) ----------

  var FIM_VIAGEM = {
    usuario: "Pronto! Você parou de compartilhar sua localização. Obrigado por ajudar.",
    separou_do_onibus: "Parece que você desceu do ônibus. Paramos de compartilhar sua localização.",
    fora_da_rota: "Você saiu do trajeto da linha. Paramos de compartilhar sua localização.",
    fim_da_linha: "Fim da linha! Paramos de compartilhar sua localização.",
    inatividade: "Não recebemos sua localização por alguns minutos. A viagem foi encerrada.",
    sem_sinal_gps: "Não conseguimos obter sua localização. A viagem foi encerrada.",
    tempo_max: "Sua viagem passou de 3 horas e foi encerrada.",
    permissao_negada: "A permissão de localização foi negada. Sem ela não dá para compartilhar a viagem.",
    viagem_desconhecida: "Sua viagem foi encerrada. Toque em “Estou neste ônibus” para começar outra.",
    consentimento_revogado: "Autorização retirada. Paramos de compartilhar sua localização."
  };

  var linhaDoModalViagem = null;

  function mesmaLinha(v, linha) { return !!v && String(v.linhaId) === String(linha.id); }

  // Botão que alterna entre "Estou neste ônibus" e "Saí do ônibus".
  // registrarCancelamento recebe a função que para de acompanhar a viagem.
  function botaoViagem(linha, registrarCancelamento) {
    var b = el("button", { type: "button" });
    function desenhar(v) {
      var aqui = mesmaLinha(v, linha);
      b.className = "btn btn-bloco btn-viagem " + (aqui ? "btn-contorno" : "btn-amarelo");
      b.replaceChildren(icone(aqui ? "sair" : "sinal", 20), aqui ? "Saí do ônibus" : "Estou neste ônibus");
    }
    b.addEventListener("click", function () {
      if (mesmaLinha(S.viagem.atual(), linha)) S.viagem.encerrar("usuario");
      else pedirInicioViagem(linha);
    });
    desenhar(S.viagem.atual());
    registrarCancelamento(S.viagem.aoMudar(desenhar));
    return b;
  }

  function pedirInicioViagem(linha) {
    var atual = S.viagem.atual();
    if (atual) {
      if (!window.confirm("Você está compartilhando a viagem na linha " + atual.linhaNumero + ". Encerrar e começar na linha " + linha.numero + "?")) return;
      S.viagem.encerrar("trocou_de_linha");
    }
    if (!S.viagem.disponivel()) { avisar("Seu navegador não oferece localização. O restante do app continua funcionando."); return; }
    var demo = window.DaSinalColaborativo.simulando();
    // Com o consentimento já dado, só a demonstração pergunta de novo (para escolher o GPS simulado).
    if (S.viagem.consentimentoAceito() && !demo) { iniciarViagem(linha, false); return; }
    linhaDoModalViagem = linha;
    ultimoFocoAntesDoModal = document.activeElement;
    $("#modal-viagem-linha").textContent = "linha " + linha.numero + " (" + linha.nome + ")";
    $("#modal-viagem-simular").hidden = !demo;
    $("#viagem-concordo").textContent = S.viagem.consentimentoAceito() ? "Começar a compartilhar" : "Concordo, compartilhar";
    $("#modal-viagem").hidden = false;
    $("#viagem-concordo").focus();
  }

  function fecharModalViagem() {
    $("#modal-viagem").hidden = true;
    linhaDoModalViagem = null;
    if (ultimoFocoAntesDoModal && ultimoFocoAntesDoModal.focus) ultimoFocoAntesDoModal.focus();
  }

  function iniciarViagem(linha, simularGps) {
    S.viagem.iniciar(linha, { simularGps: simularGps }).then(function () {
      avisar("Obrigado! Sua localização está ajudando a mostrar o ônibus da linha " + linha.numero + ". Mantenha o app aberto.");
    }, function (erro) {
      var codigo = erro && erro.codigo;
      var mensagem = String((erro && erro.message) || "");
      if (codigo === "ja_ativa") return;
      if (codigo === "sem_suporte") avisar("Seu navegador não oferece localização.");
      else if (mensagem.indexOf("limite_diario") >= 0) avisar("Você atingiu o limite de viagens compartilhadas de hoje. Obrigado por ajudar!");
      else if (mensagem.indexOf("linha_invalida") >= 0) avisar("Esta linha não está disponível para compartilhar agora.");
      else avisar("Não foi possível começar a compartilhar agora. Verifique sua conexão e tente de novo.");
    });
  }

  $("#viagem-concordo").addEventListener("click", function () {
    var linha = linhaDoModalViagem;
    var simular = !$("#modal-viagem-simular").hidden && $("#viagem-simular").checked;
    S.viagem.registrarConsentimento();
    fecharModalViagem();
    if (linha) iniciarViagem(linha, simular);
  });
  $("#viagem-cancelar").addEventListener("click", function () {
    fecharModalViagem();
    avisar("Tudo bem. O app continua funcionando sem compartilhar sua viagem.");
  });

  function textoSituacaoViagem(v) {
    var s = v.situacao;
    var sufixo = v.simulada ? " (localização simulada)" : "";
    if (v.gpsFraco) return "Sinal de GPS fraco. Tentando de novo…" + sufixo;
    if (v.semSinal) return "Procurando o sinal de GPS…" + sufixo;
    if (!s) return "Enviando sua localização…" + sufixo;
    if (s.onibusId && v.onibus) {
      var outros = v.onibus.qtdPassageiros - 1;
      var alvo = Math.round(window.DaSinalEstimador.PADRAO.VALIDAR_SEGUNDOS / 60);
      var progresso = s.validada ? " · viagem validada ✔"
        : " · validando: " + Math.min(alvo, Math.floor((s.segundosValidos || 0) / 60)) + " de " + alvo + " min";
      return "Você está ajudando a mostrar este ônibus" + (outros > 0 ? " com mais " + textoPassageiros(outros) : "") + progresso + sufixo;
    }
    if (!s.emRota) return "Você parece estar fora do trajeto desta linha" + sufixo;
    return "Confirmando que você está no ônibus…" + sufixo;
  }

  function atualizarFaixaViagem(v) {
    var faixa = $("#faixa-viagem");
    document.body.classList.toggle("com-viagem", !!v);
    faixa.hidden = !v;
    if (!v) return;
    $("#faixa-titulo").textContent = "Compartilhando na linha " + v.linhaNumero;
    $("#faixa-status").textContent = textoSituacaoViagem(v);
    $("#faixa-link").setAttribute("href", "#/mapa/" + v.linhaId);
  }

  $("#faixa-sair").addEventListener("click", function () { S.viagem.encerrar("usuario"); });

  S.viagem.aoMudar(function (v, evento) {
    atualizarFaixaViagem(v);
    if (evento && evento.tipo === "fim" && FIM_VIAGEM[evento.motivo]) {
      avisar(FIM_VIAGEM[evento.motivo], evento.motivo !== "usuario");
    }
    if (telaAtual === "perfil") atualizarPerfilConsentimento();
  });

  // ---------- Avisos dos passageiros (atraso, lotação, defeito…) ----------

  var A = S.avisos;
  var MSG_AVISO = {
    texto_obrigatorio: "Conte em poucas palavras qual é o problema.",
    texto_longo: "O detalhe pode ter no máximo 80 caracteres.",
    texto_curto: "Escreva um pouco mais no detalhe, ou deixe em branco.",
    "texto_recusado:link": "Tire o link do texto.",
    "texto_recusado:contato": "Não coloque telefone nem e-mail no aviso.",
    "texto_recusado:palavra": "Reescreva o detalhe sem palavras ofensivas.",
    limite_avisos: "Você já enviou 5 avisos na última hora. Tente de novo mais tarde.",
    aviso_repetido: "Você já avisou isso nesta linha. O aviso continua valendo.",
    aviso_encerrado: "Esse aviso já saiu do ar.",
    proprio_aviso: "Esse aviso é seu.",
    limite_confirmacoes: "Muitas confirmações em pouco tempo. Tente de novo mais tarde.",
    linha_invalida: "Esta linha não está disponível agora.",
    tipo_invalido: "Escolha o tipo do problema."
  };

  function mensagemAviso(erro) {
    var m = String((erro && erro.message) || "");
    var chave = Object.keys(MSG_AVISO).filter(function (k) { return m.indexOf(k) >= 0; })
      .sort(function (a, b) { return b.length - a.length; })[0];
    return chave ? MSG_AVISO[chave] : "Não foi possível enviar agora. Verifique sua conexão e tente de novo.";
  }

  function tempoRelativo(ms) {
    var min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return "agora";
    if (min < 60) return "há " + min + " min";
    var h = Math.floor(min / 60);
    return "há " + h + " h" + (min % 60 ? " " + (min % 60) + " min" : "");
  }

  function itemAviso(a, linha) {
    var t = A.tipo(a.tipo);
    var meta = tempoRelativo(a.criadoEm) +
      (a.confirmacoes ? " · " + (a.confirmacoes === 1 ? "1 pessoa confirmou" : a.confirmacoes + " pessoas confirmaram") : "");
    var acao;
    if (a.meu) {
      acao = el("button", { type: "button", class: "link-botao av-retirar", text: "Retirar" });
      acao.addEventListener("click", function () {
        A.retirar(a.id, linha.id).then(function () { avisar("Aviso retirado. Obrigado por manter as informações em dia."); },
          function (e) { avisar(mensagemAviso(e)); });
      });
    } else {
      acao = el("button", { type: "button", class: "btn btn-contorno btn-pequeno av-confirmar", "aria-pressed": String(!!a.confirmei),
        "aria-label": a.confirmei ? "Você já confirmou este aviso" : "Também vi: " + t.nome },
        icone("joinha", 18), a.confirmei ? "Confirmado" : "Também vi");
      if (a.confirmei) acao.disabled = true;
      acao.addEventListener("click", function () {
        acao.disabled = true;
        A.confirmar(a.id, linha.id).then(function () { avisar("Obrigado por confirmar!"); },
          function (e) { acao.disabled = false; avisar(mensagemAviso(e)); });
      });
    }
    return el("li", { class: "av-item" + (a.confirmacoes >= 2 ? " forte" : "") },
      el("span", { class: "av-icone av-" + a.tipo }, icone(t.icone, 20)),
      el("div", { class: "av-textos" },
        el("strong", { text: t.nome }),
        a.texto ? el("span", { class: "av-texto", text: "“" + a.texto + "”" }) : null,
        el("small", {}, meta),
        (a.naViagem || a.meu) ? el("span", { class: "av-selos" },
          a.naViagem ? el("span", { class: "av-selo" }, icone("bus", 12), "de quem estava no ônibus") : null,
          a.meu ? el("span", { class: "av-selo meu", text: "seu aviso" }) : null) : null),
      acao);
  }

  // Cartão com os avisos de uma linha. Atualiza a cada 30 s e quando este app
  // envia ou confirma um aviso. compacto: só os 2 principais (usado no mapa).
  function cardAvisos(linha, registrarCancelamento, compacto) {
    var lista = el("ul", { class: "av-lista" });
    var contador = el("span", { class: "contador" });
    var botao = el("button", { type: "button", class: "btn btn-contorno btn-pequeno btn-bloco av-avisar" }, icone("megafone", 18), "Avisar problema");
    botao.addEventListener("click", function () { abrirModalAviso(linha); });
    var mais = compacto ? el("a", { class: "av-mais", href: "#/linha/" + linha.id, hidden: "" }) : null;
    var card = el("section", { class: compacto ? "av-card compacto" : "card av-card", "aria-label": "Avisos dos passageiros da linha " + linha.numero },
      el("div", { class: "av-cabeca" }, el("h2", {}, icone("alerta", 18), "Avisos dos passageiros"), contador),
      lista, mais, botao);

    var parado = false;
    function carregar() {
      A.listar(linha.id).then(function (avisos) {
        if (parado) return;
        contador.textContent = avisos.length ? avisos.length + " agora" : "";
        if (!avisos.length) {
          preencher(lista, el("li", { class: "av-vazio", text: compacto ? "Nenhum problema avisado agora."
            : "Nenhum problema avisado agora. Viu algo errado? Avise quem está esperando." }));
          if (mais) mais.hidden = true;
          return;
        }
        var mostrar = compacto ? avisos.slice(0, 2) : avisos;
        preencher.apply(null, [lista].concat(mostrar.map(function (a) { return itemAviso(a, linha); })));
        if (mais) { mais.hidden = avisos.length <= 2; mais.textContent = "Ver todos os avisos (" + avisos.length + ")"; }
      }, function () {
        if (!parado) preencher(lista, el("li", { class: "av-vazio", text: "Não foi possível carregar os avisos agora." }));
      });
    }
    carregar();
    var timer = setInterval(carregar, 30000);
    var desligar = A.aoMudar(function (id) { if (String(id) === String(linha.id)) carregar(); });
    registrarCancelamento(function () { parado = true; clearInterval(timer); desligar(); });
    return card;
  }

  // Selo "N avisos" nas listas de linhas.
  var avisosCache = {};
  function seloAvisos(l) {
    var n = avisosCache[l.id];
    if (!n) return null;
    return el("span", { class: "pill av-pill", title: n === 1 ? "1 aviso de passageiro agora" : n + " avisos de passageiros agora" },
      icone("alerta", 12), n === 1 ? "1 aviso" : n + " avisos");
  }
  function carregarResumoAvisos() {
    return A.resumo().then(function (r) { avisosCache = r || {}; }, function () { avisosCache = {}; });
  }

  // Pop-up "Avisar problema"
  var linhaDoModalAviso = null;
  var tipoEscolhido = null;

  A.TIPOS.forEach(function (t) {
    var input = el("input", { type: "radio", name: "aviso-tipo", value: t.codigo });
    input.addEventListener("change", function () { tipoEscolhido = t.codigo; atualizarFormAviso(); });
    $("#aviso-tipos").append(el("label", { class: "av-tipo av-" + t.codigo }, input, icone(t.icone, 22), el("span", { text: t.nome })));
  });

  function atualizarFormAviso() {
    var texto = $("#aviso-texto").value;
    $("#aviso-contador").textContent = texto.length + "/80";
    $("#aviso-texto-rotulo").textContent = tipoEscolhido === "outro" ? "Qual é o problema?" : "Detalhe (opcional)";
    $("#aviso-enviar").disabled = !tipoEscolhido || (tipoEscolhido === "outro" && texto.trim().length < 3);
    $("#aviso-erro").hidden = true;
  }

  function erroNoFormAviso(texto) {
    $("#aviso-erro").textContent = texto;
    $("#aviso-erro").hidden = false;
  }

  function abrirModalAviso(linha) {
    linhaDoModalAviso = linha;
    tipoEscolhido = null;
    $("#form-aviso").reset();
    atualizarFormAviso();
    $("#modal-aviso-linha").textContent = "linha " + linha.numero;
    ultimoFocoAntesDoModal = document.activeElement;
    $("#modal-aviso").hidden = false;
    $("#aviso-tipos input").focus();
  }

  function fecharModalAviso() {
    $("#modal-aviso").hidden = true;
    linhaDoModalAviso = null;
    if (ultimoFocoAntesDoModal && ultimoFocoAntesDoModal.focus) ultimoFocoAntesDoModal.focus();
  }

  $("#aviso-texto").addEventListener("input", atualizarFormAviso);
  $("#aviso-cancelar").addEventListener("click", fecharModalAviso);
  $("#modal-aviso").addEventListener("click", function (e) { if (e.target === e.currentTarget) fecharModalAviso(); });
  $("#form-aviso").addEventListener("submit", function (e) {
    e.preventDefault();
    var linha = linhaDoModalAviso;
    if (!linha || !tipoEscolhido) return;
    var texto = $("#aviso-texto").value;
    var recusa = texto.trim() ? A.textoRecusado(texto) : null;
    if (recusa) { erroNoFormAviso(MSG_AVISO["texto_recusado:" + recusa]); return; }
    var b = $("#aviso-enviar");
    b.disabled = true;
    b.textContent = "Enviando…";
    A.criar(linha, tipoEscolhido, texto).then(function (r) {
      fecharModalAviso();
      avisar(r && r.juntou ? "Outra pessoa já tinha avisado isso. Contamos como “Também vi”."
        : "Aviso enviado! Obrigado por ajudar quem está esperando o ônibus.", true);
      carregarResumoAvisos();
    }, function (erro) {
      erroNoFormAviso(mensagemAviso(erro));
      b.disabled = false;
    }).then(function () { b.textContent = "Enviar aviso"; });
  });

  // ---------- Pontos ----------

  var pontosAgrupados = null;

  function desenharPontos() {
    var termo = normalizar($("#busca-ponto").value.trim());
    var visiveis = (pontosAgrupados || []).filter(function (g) { return !termo || normalizar(g.nome).indexOf(termo) >= 0; });
    var lista = $("#lista-pontos");
    if (!visiveis.length) {
      lista.replaceChildren(el("p", { class: "vazio", text: termo ? "Nenhum ponto encontrado para essa busca." : "Nenhum ponto cadastrado." }));
      return;
    }
    lista.replaceChildren.apply(lista, visiveis.map(function (g) {
      var mini = el("div", { class: "mini-linhas" });
      g.itens.forEach(function (it) {
        mini.append(el("a", { class: "mini-linha", href: "#/mapa/" + it.linha.id + "/" + it.ponto.id,
          "aria-label": "Ver " + g.nome + " no mapa da linha " + it.linha.numero, title: it.linha.nome },
          icone("bus", 14), it.linha.numero));
      });
      return el("article", { class: "card ponto-card" },
        el("span", { class: "ponto-card-icone" }, icone("pin", 20)),
        el("div", {}, el("strong", { text: g.nome }), mini));
    }));
  }

  function abrirPontos() {
    var versao = mostrarTela("pontos");
    Promise.all([carregarLinhas(), S.dados.listarTodosPontos()]).then(function (r) {
      if (versao !== versaoTela) return;
      var linhaPorId = {};
      r[0].forEach(function (l) { linhaPorId[l.id] = l; });
      var grupos = {};
      r[1].forEach(function (p) {
        var l = linhaPorId[p.linha_id];
        if (!l) return;
        var chave = normalizar(p.nome);
        if (!grupos[chave]) grupos[chave] = { nome: p.nome, itens: [] };
        grupos[chave].itens.push({ linha: l, ponto: p });
      });
      pontosAgrupados = Object.keys(grupos).map(function (k) { return grupos[k]; })
        .sort(function (a, b) { return a.nome.localeCompare(b.nome, "pt-BR"); });
      desenharPontos();
    }).catch(function () {
      $("#lista-pontos").replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar os pontos. Verifique sua conexão e recarregue a página." }));
    });
  }

  $("#busca-ponto").addEventListener("input", desenharPontos);

  // ---------- Perfil ----------

  function abrirPerfil() {
    mostrarTela("perfil");
    $("#perfil-qtd-fav").textContent = favoritos.length ? String(favoritos.length) : "";
    $("#perfil-alarme").textContent = alarme && alarme.ativo ? "Ativo" : "";
    atualizarPerfilConsentimento();
    atualizarCardPontos();
    atualizarPerfilConta();
  }

  function atualizarCardPontos() {
    var card = $("#perfil-pontos");
    if (!S.viagem.disponivel()) { card.hidden = true; return; }
    S.pontos.resumo().then(function (r) {
      card.hidden = false;
      $("#perfil-nivel-num").textContent = String(r.nivel.nivel);
      $("#perfil-nivel-nome").textContent = "Nível " + r.nivel.nivel + " · " + r.nivel.nome;
      $("#perfil-pontos-total").textContent = String(r.pontosTotal);
      $("#perfil-barra").style.width = Math.round(r.nivel.progresso * 100) + "%";
      $("#perfil-faltam").textContent = r.nivel.proximo ? "Faltam " + r.nivel.faltam + " para " + r.nivel.proximo.nome : "Nível máximo!";
    }, function () { card.hidden = true; });
  }

  // ---------- Meus pontos (níveis, conquistas, ranking e histórico) ----------

  var ROTULO_CONFIABILIDADE = { alta: "Alta", normal: "Normal", baixa: "Baixa" };

  function dataHora(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " às " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function abrirMeusPontos() {
    var versao = mostrarTela("meus-pontos");
    var caixa = $("#meus-pontos-conteudo");
    if (!caixa.childElementCount) caixa.replaceChildren(el("p", { class: "vazio", text: "Carregando…" }));
    Promise.all([S.pontos.resumo(), S.pontos.ranking().catch(function () { return null; }),
      S.conta.estado().catch(function () { return { tipo: "nenhuma" }; })]).then(function (r) {
      if (versao !== versaoTela) return;
      desenharMeusPontos(r[0], r[1]);
      // Ainda sem conta e já com pontos: convida a salvar.
      if (r[2].tipo !== "cadastrada" && r[0].pontosTotal > 0) {
        caixa.prepend(el("a", { class: "card conta-chamada", href: "#/conta" },
          el("span", { class: "conta-chamada-icone" }, icone("escudo", 22)),
          el("span", {}, el("strong", { text: "Salve seus pontos" }),
            el("small", { text: "Seus " + r[0].pontosTotal + " pontos estão só neste aparelho. Crie um usuário e uma senha para não perdê-los." })),
          icone("avancar", 20)));
      }
    }).catch(function () {
      caixa.replaceChildren(el("p", { class: "vazio", text: "Não foi possível carregar seus pontos agora. Verifique sua conexão." }));
    });
  }

  function numeroResumo(valor, rotulo) {
    return el("div", {}, el("strong", { text: String(valor) }), el("small", { text: rotulo }));
  }

  function desenharMeusPontos(res, ranking) {
    var n = res.nivel;
    var R = window.DaSinalPontos.REGRAS;

    var nivel = el("div", { class: "card nivel-card" },
      el("div", { class: "nivel-cabeca" },
        el("span", { class: "nivel-selo grande", text: String(n.nivel), "aria-hidden": "true" }),
        el("div", {}, el("small", { text: "Nível " + n.nivel }), el("strong", { text: n.nome }))),
      el("p", { class: "nivel-pontos" }, el("strong", { text: String(res.pontosTotal) }), " pontos"),
      el("span", { class: "barra", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(n.progresso * 100)), "aria-label": "Progresso até o próximo nível" },
        el("i", { style: "width:" + Math.round(n.progresso * 100) + "%" })),
      el("small", { class: "nivel-faltam", text: n.proximo ? "Faltam " + n.faltam + " pontos para " + n.proximo.nome : "Você chegou ao nível máximo!" }),
      el("div", { class: "nivel-numeros" },
        numeroResumo(res.viagensValidadas, "viagens validadas"),
        numeroResumo(res.minutos, "minutos ajudando"),
        numeroResumo(res.semana, "pontos na semana"),
        numeroResumo(ROTULO_CONFIABILIDADE[res.confiabilidade], "confiabilidade")));

    var regras = el("details", { class: "card regras" },
      el("summary", {}, icone("info", 20), el("span", { text: "Como ganhar pontos" })),
      el("ul", {},
        el("li", { text: "+" + (R.PONTOS_INICIO + R.PONTOS_VALIDADA) + " quando a viagem é validada, ou seja, você esteve mesmo num ônibus por pelo menos 3 minutos." }),
        el("li", { text: "+1 a cada 2 minutos ajudando, até +" + R.MAX_CONTRIBUICAO + " por viagem." }),
        el("li", { text: "+" + R.PONTOS_CONFIRMADA + " quando outro passageiro confirma o mesmo ônibus." }),
        el("li", { text: "+" + R.PONTOS_AVISO_CONFIRMADO + " quando " + R.CONFIRMACOES_AVISO + " pessoas confirmam um aviso seu (atraso, lotação, defeito…)." }),
        el("li", { text: "Até " + R.LIMITE_PONTOS_DIA + " pontos e " + R.LIMITE_VIAGENS_DIA + " viagens pontuadas por dia." }),
        el("li", { text: "Viagens que não se confirmam não pontuam. Muitas delas seguidas reduzem os pontos das próximas." })),
      el("p", { class: "nota", text: "Os pontos premiam quem ajuda de verdade. Deixar a localização ligada fora do ônibus, a pé ou de carro não conta." }));

    var conquistas = el("div", { class: "conquistas" });
    res.conquistas.forEach(function (c) {
      conquistas.append(el("div", { class: "conquista" + (c.obtida ? " obtida" : "") },
        el("span", { class: "conquista-icone", "aria-hidden": "true" }, icone(c.obtida ? "escudo" : "relogio", 22)),
        el("strong", { text: c.nome }),
        el("small", { text: c.descricao }),
        c.obtida ? el("em", { text: "Obtida em " + dataHora(c.em) }) : el("em", { text: "Ainda não" })));
    });
    var obtidas = res.conquistas.filter(function (c) { return c.obtida; }).length;

    // Ranking (opcional, só com apelido)
    var apelido = el("input", { type: "text", id: "rk-apelido", maxlength: "30", autocomplete: "off", placeholder: "Seu apelido público" });
    apelido.value = res.perfil.apelido || "";
    var aparece = el("input", { type: "checkbox", role: "switch", class: "switch", id: "rk-aparece" });
    aparece.checked = !!res.perfil.aparece;
    var form = el("form", { class: "ranking-form" },
      el("label", { class: "campo" }, el("span", { text: "Apelido" }), apelido),
      el("label", { class: "linha-switch" }, el("span", { text: "Aparecer no ranking" }), aparece),
      el("button", { type: "submit", class: "btn btn-primario btn-pequeno", text: "Salvar" }));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var nome = apelido.value.trim();
      if (aparece.checked && (nome.length < 2 || nome.length > 30)) { avisar("Escolha um apelido de 2 a 30 caracteres."); return; }
      S.pontos.atualizarPerfil(nome, aparece.checked).then(function () {
        avisar(aparece.checked ? "Pronto! Você aparece no ranking como " + nome + "." : "Pronto! Você não aparece no ranking.");
        abrirMeusPontos();
      }, function (erro) {
        var m = String((erro && erro.message) || "");
        avisar(m.indexOf("apelido_em_uso") >= 0 ? "Esse apelido já está em uso. Escolha outro."
          : m.indexOf("apelido_invalido") >= 0 ? "Use só letras, números, espaço, ponto, hífen ou sublinhado."
          : m.indexOf("sem_sessao") >= 0 ? "Compartilhe uma viagem primeiro para ter um perfil."
          : "Não foi possível salvar agora.");
      });
    });

    var lista;
    if (ranking === null) lista = el("p", { class: "vazio", text: "Não foi possível carregar o ranking agora." });
    else if (!ranking.length) lista = el("p", { class: "vazio", text: "Ninguém no ranking ainda nesta semana." });
    else {
      lista = el("ol", { class: "ranking" });
      ranking.slice(0, 20).forEach(function (p) {
        lista.append(el("li", { class: p.voce ? "voce" : "" },
          el("span", { class: "ranking-pos", text: p.posicao + "º" }),
          el("span", { class: "ranking-nome", text: p.apelido + (p.voce ? " (você)" : "") }),
          el("strong", { text: p.pontos + " pts" })));
      });
    }

    // Histórico, agrupado por viagem
    var grupos = [];
    res.historico.forEach(function (h) {
      var g = grupos[grupos.length - 1];
      var chave = h.viagemId || (h.avisoId ? "aviso:" + h.avisoId : null);
      if (!g || g.chave !== chave) { g = { chave: chave, aviso: !h.viagemId && !!h.avisoId, linhaNumero: h.linhaNumero, em: h.em, itens: [], total: 0 }; grupos.push(g); }
      g.itens.push(h);
      g.total += h.pontos;
    });
    var historico = grupos.length ? el("div", { class: "historico" }) : el("p", { class: "vazio", text: "Você ainda não tem pontos. Toque em “Estou neste ônibus” quando estiver dentro de um ônibus." });
    grupos.slice(0, 15).forEach(function (g) {
      var itens = el("ul", {});
      g.itens.forEach(function (i) {
        itens.append(el("li", { class: i.pontos < 0 ? "negativo" : "" }, el("span", { text: i.descricao }), el("span", { text: (i.pontos > 0 ? "+" : "") + i.pontos })));
      });
      historico.append(el("div", { class: "card historico-viagem" },
        el("div", { class: "historico-topo" },
          el("span", {}, el("strong", { text: (g.aviso ? "Aviso · " : "") + (g.linhaNumero ? "Linha " + g.linhaNumero : g.aviso ? "" : "Viagem") }), el("small", { text: dataHora(g.em) })),
          el("strong", { class: "historico-total", text: "+" + g.total })),
        itens));
    });

    preencher($("#meus-pontos-conteudo"),
      nivel,
      regras,
      el("div", { class: "secao-titulo" }, el("h2", { text: "Conquistas" }), el("span", { class: "contador", text: obtidas + " de " + res.conquistas.length })),
      conquistas,
      el("div", { class: "secao-titulo" }, el("h2", { text: "Ranking da semana" })),
      el("div", { class: "card ranking-card" },
        form,
        el("p", { class: "nota", text: "O ranking mostra só o apelido que você escolher, e só se você quiser. Nenhuma localização aparece." +
          (S.pontos.noServidor ? "" : " Nesta demonstração, os outros participantes são fictícios.") }),
        lista),
      el("div", { class: "secao-titulo" }, el("h2", { text: "Histórico de pontos" })),
      historico);
  }

  var lembrouDeSalvar = false;
  S.pontos.aoMudar(function (ev) {
    // Depois do aviso de fim da viagem.
    setTimeout(function () {
      if (ev.tipo === "aviso_confirmado") {
        avisar("+" + ev.total + " pontos: outros passageiros confirmaram seu aviso na linha " + ev.linhaNumero + "!", true);
      } else if (ev.tipo === "pontuada") {
        avisar("+" + ev.total + " pontos pela viagem na linha " + ev.linhaNumero + "! Obrigado por ajudar.", true);
        (ev.conquistas || []).forEach(function (c) { avisar("Conquista desbloqueada: " + c.nome, true); });
        // Uma vez por sessão: lembra de salvar os pontos numa conta.
        if (!lembrouDeSalvar) S.conta.estado().then(function (est) {
          if (est.tipo === "cadastrada" || lembrouDeSalvar) return;
          lembrouDeSalvar = true;
          setTimeout(function () { avisar("Dica: crie uma conta em Perfil → Minha conta para não perder seus pontos."); }, 2500);
        });
      } else if (ev.motivo === "limite_viagens_dia") {
        avisar("Viagem validada! Você já chegou ao limite de viagens pontuadas de hoje.");
      } else if (ev.motivo === "nao_validada" && ev.duracaoMs >= 60000) {
        avisar("Esta viagem não chegou a ser confirmada (são precisos 3 minutos junto de um ônibus), então não gerou pontos.");
      }
      if (telaAtual === "perfil") atualizarCardPontos();
      if (telaAtual === "meus-pontos") abrirMeusPontos();
    }, 700);
  });

  function atualizarPerfilConsentimento() {
    $("#perfil-consentimento").hidden = !S.viagem.consentimentoAceito();
  }

  $("#btn-revogar").addEventListener("click", function () {
    var ativa = S.viagem.ativa();
    S.viagem.revogarConsentimento();
    atualizarPerfilConsentimento();
    if (!ativa) avisar("Autorização retirada. Vamos pedir de novo se você quiser compartilhar uma viagem.");
  });

  $("#btn-excluir-dados").addEventListener("click", function () {
    var cadastrada = $("#perfil-conta").textContent !== "";
    if (!window.confirm((cadastrada ? "Apagar sua conta e todos os dados dela: " : "Apagar ") +
      "viagens compartilhadas, autorizações, avisos, pontos e perfil? Isso não pode ser desfeito.")) return;
    S.viagem.excluirMeusDados().then(S.pontos.apagar).then(function () {
      if (!A.noServidor) A.apagarDemo(); // no servidor, excluir_meus_dados já apaga os avisos e a conta
      S.conta.apagar();
      atualizarPerfilConsentimento();
      atualizarCardPontos();
      avisar("Pronto. Seus dados de viagem foram apagados.");
    }, function () {
      avisar("Não foi possível apagar agora. Verifique sua conexão e tente de novo.");
    });
  });

  // ---------- Minha conta (usuário e senha, opcional) ----------

  var CT = S.conta;
  var MENSAGENS_CONTA = {
    usuario_tamanho: "O usuário precisa ter de 3 a 20 caracteres.",
    usuario_caracteres: "No usuário, use só letras sem acento, números, ponto, hífen ou sublinhado, começando por letra ou número.",
    usuario_em_uso: "Esse usuário já existe. Escolha outro.",
    senha_curta: "A senha precisa ter pelo menos 8 caracteres.",
    senha_longa: "A senha pode ter no máximo 72 caracteres.",
    senha_fraca: "Essa senha é fácil de adivinhar. Escolha outra.",
    senhas_diferentes: "As duas senhas não são iguais.",
    login_invalido: "Usuário ou senha incorretos.",
    codigo_invalido: "Usuário ou código de recuperação incorretos.",
    bloqueado: "Muitas tentativas erradas. Espere 15 minutos e tente de novo.",
    muitas_tentativas: "Muitas tentativas em pouco tempo. Espere um pouco e tente de novo.",
    ja_cadastrada: "Você já está conectado a uma conta.",
    conta_anonima: "Crie uma conta primeiro.",
    confirmacao_ligada: "O cadastro está desativado no servidor agora (confirmação de e-mail ligada no Supabase). Avise a equipe do Dá sinal.",
    falha: "Não foi possível agora. Verifique sua conexão e tente de novo."
  };

  function mensagemConta(e) { return MENSAGENS_CONTA[(e && e.codigo) || "falha"] || MENSAGENS_CONTA.falha; }

  function campo(rotulo, input, ajuda) {
    return el("label", { class: "campo" }, el("span", { text: rotulo }), input, ajuda ? el("small", { class: "campo-ajuda", text: ajuda }) : null);
  }

  function entrada(tipo, id, extra) {
    return el("input", Object.assign({ type: tipo, id: id, class: "entrada", autocapitalize: "none", spellcheck: "false" }, extra || {}));
  }

  // Formulário genérico: campos, botão principal, mensagem de erro e ligações.
  function formulario(campos, rotuloBotao, aoEnviar) {
    var erroMsg = el("p", { class: "conta-erro", role: "alert", hidden: "" });
    var botao = el("button", { type: "submit", class: "btn btn-amarelo btn-bloco", text: rotuloBotao });
    var f = el("form", { class: "card conta-form", novalidate: "" });
    campos.forEach(function (c) { f.append(c); });
    f.append(erroMsg, botao);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      erroMsg.hidden = true;
      botao.disabled = true;
      var texto = botao.textContent;
      botao.textContent = "Aguarde…";
      Promise.resolve().then(aoEnviar).catch(function (x) {
        erroMsg.textContent = mensagemConta(x);
        erroMsg.hidden = false;
      }).then(function () { botao.disabled = false; botao.textContent = texto; });
    });
    return f;
  }

  function mostrarSenhas() {
    var caixa = el("input", { type: "checkbox", class: "conta-mostrar" });
    caixa.addEventListener("change", function () {
      caixa.closest("form").querySelectorAll('input[data-senha]').forEach(function (i) { i.type = caixa.checked ? "text" : "password"; });
    });
    return el("label", { class: "conta-check" }, caixa, el("span", { text: "Mostrar senha" }));
  }

  function ligacao(texto, destino) {
    return el("a", { class: "conta-link", href: "#/conta/" + destino, text: texto });
  }

  // Quem troca de conta com viagem em andamento: encerra antes.
  function encerrarViagemAntes() {
    if (S.viagem.ativa()) S.viagem.encerrar("usuario");
  }

  function abrirConta(modo) {
    var versao = mostrarTela("conta");
    var caixa = $("#conta-conteudo");
    caixa.replaceChildren(el("p", { class: "vazio", text: "Carregando…" }));
    Promise.all([CT.estado(), S.pontos.resumo().catch(function () { return null; })]).then(function (r) {
      if (versao !== versaoTela) return;
      var est = r[0];
      var pontos = r[1] ? r[1].pontosTotal : 0;
      if (est.tipo === "cadastrada") desenharContaConectada(est);
      else if (modo === "entrar") desenharEntrar(pontos);
      else if (modo === "recuperar") desenharRecuperar();
      else desenharCadastro(pontos);
    }, function () {
      caixa.replaceChildren(el("p", { class: "vazio", text: MENSAGENS_CONTA.falha }));
    });
  }

  function notaDemoConta() {
    return CT.noServidor ? null : el("p", { class: "nota", text: "Nesta demonstração, a conta fica guardada só neste navegador." });
  }

  function desenharCadastro(pontos) {
    var usuario = entrada("text", "ct-usuario", { maxlength: "20", autocomplete: "username" });
    var senha = entrada("password", "ct-senha", { maxlength: "72", autocomplete: "new-password", "data-senha": "" });
    var senha2 = entrada("password", "ct-senha2", { maxlength: "72", autocomplete: "new-password", "data-senha": "" });
    var form = formulario([
      campo("Usuário", usuario, "De 3 a 20 caracteres: letras sem acento, números, ponto, hífen ou sublinhado. Não aparece no ranking."),
      campo("Senha", senha, "Pelo menos 8 caracteres."),
      campo("Repita a senha", senha2),
      mostrarSenhas()
    ], "Criar conta e salvar meus pontos", function () {
      if (senha.value !== senha2.value) throw { codigo: "senhas_diferentes" };
      encerrarViagemAntes();
      return CT.criar(usuario.value, senha.value).then(function (r) {
        desenharCodigo(r.codigo, "Conta criada! Seus pontos agora estão salvos na conta " + CT.normalizar(usuario.value) + ".");
      });
    });
    preencher($("#conta-conteudo"),
      el("div", { class: "card conta-intro" },
        el("span", { class: "conta-chamada-icone" }, icone("escudo", 24)),
        el("div", {},
          el("h2", { text: "Salve seus pontos" }),
          el("p", { text: "Com uma conta, seus pontos, conquistas e posição no ranking não se perdem se você trocar de celular ou limpar o navegador. Não pedimos e-mail, telefone nem nome." }),
          pontos > 0 ? el("p", { class: "conta-destaque", text: "Você tem " + pontos + " pontos neste aparelho. Eles vão junto para a sua conta." }) : null)),
      form,
      el("p", { class: "conta-rodape" }, "Já tem conta? ", ligacao("Entrar", "entrar")),
      notaDemoConta());
    usuario.focus();
  }

  function desenharEntrar(pontos) {
    var usuario = entrada("text", "ct-usuario", { maxlength: "20", autocomplete: "username" });
    var senha = entrada("password", "ct-senha", { maxlength: "72", autocomplete: "current-password", "data-senha": "" });
    var form = formulario([
      campo("Usuário", usuario),
      campo("Senha", senha),
      mostrarSenhas()
    ], "Entrar", function () {
      encerrarViagemAntes();
      return CT.entrar(usuario.value, senha.value).then(function () {
        avisar("Pronto! Você entrou na conta " + CT.normalizar(usuario.value) + ".");
        location.hash = "#/meus-pontos";
      });
    });
    preencher($("#conta-conteudo"),
      el("div", { class: "card conta-intro" },
        el("span", { class: "conta-chamada-icone" }, icone("usuario", 24)),
        el("div", {},
          el("h2", { text: "Entrar na sua conta" }),
          el("p", { text: "Use o usuário e a senha que você criou." }),
          pontos > 0 ? el("p", { class: "conta-destaque", text: "Atenção: os " + pontos + " pontos deste aparelho não serão somados à conta em que você entrar. Se quiser guardá-los, crie uma conta nova com eles." }) : null)),
      form,
      el("p", { class: "conta-rodape" }, ligacao("Esqueci minha senha", "recuperar"), " · ", ligacao("Criar conta", "")),
      notaDemoConta());
    usuario.focus();
  }

  function desenharRecuperar() {
    var usuario = entrada("text", "ct-usuario", { maxlength: "20", autocomplete: "username" });
    var codigo = entrada("text", "ct-codigo", { maxlength: "20", autocomplete: "one-time-code", placeholder: "XXXX-XXXX-XXXX", class: "entrada entrada-codigo" });
    var senha = entrada("password", "ct-senha", { maxlength: "72", autocomplete: "new-password", "data-senha": "" });
    var senha2 = entrada("password", "ct-senha2", { maxlength: "72", autocomplete: "new-password", "data-senha": "" });
    var form = formulario([
      campo("Usuário", usuario),
      campo("Código de recuperação", codigo, "O código que apareceu quando você criou a conta."),
      campo("Nova senha", senha, "Pelo menos 8 caracteres."),
      campo("Repita a nova senha", senha2),
      mostrarSenhas()
    ], "Trocar a senha e entrar", function () {
      if (senha.value !== senha2.value) throw { codigo: "senhas_diferentes" };
      encerrarViagemAntes();
      return CT.recuperar(usuario.value, codigo.value, senha.value).then(function (r) {
        desenharCodigo(r.codigo, "Senha trocada! O código antigo não vale mais: guarde este novo.");
      });
    });
    preencher($("#conta-conteudo"),
      el("div", { class: "card conta-intro" },
        el("span", { class: "conta-chamada-icone" }, icone("escudo", 24)),
        el("div", {},
          el("h2", { text: "Esqueci minha senha" }),
          el("p", { text: "Como a conta não usa e-mail, o único jeito de recuperá-la é com o código de recuperação que apareceu no cadastro." }))),
      form,
      el("p", { class: "conta-rodape" }, ligacao("Voltar para entrar", "entrar")),
      notaDemoConta());
    usuario.focus();
  }

  // Mostra o código de recuperação uma única vez.
  function desenharCodigo(codigo, titulo) {
    var guardei = el("input", { type: "checkbox", id: "ct-guardei" });
    var pronto = el("button", { type: "button", class: "btn btn-amarelo btn-bloco", text: "Pronto", disabled: "" });
    guardei.addEventListener("change", function () { pronto.disabled = !guardei.checked; });
    pronto.addEventListener("click", function () { abrirConta(); });
    var copiar = el("button", { type: "button", class: "btn btn-contorno btn-pequeno", text: "Copiar código" });
    copiar.addEventListener("click", function () {
      (navigator.clipboard ? navigator.clipboard.writeText(codigo) : Promise.reject()).then(function () {
        avisar("Código copiado. Cole num lugar seguro, como suas notas.");
      }, function () { avisar("Não deu para copiar. Anote o código à mão."); });
    });
    preencher($("#conta-conteudo"),
      el("div", { class: "card conta-codigo" },
        el("h2", { text: titulo }),
        el("p", { text: "Este é o seu código de recuperação. Ele é o único jeito de recuperar a conta se você esquecer a senha. Anote ou tire um print e guarde num lugar seguro: ele não aparece de novo." }),
        el("p", { class: "codigo-recuperacao", text: codigo, "aria-label": "Código de recuperação: " + codigo.split("").join(" ") }),
        copiar,
        el("label", { class: "conta-check" }, guardei, el("span", { text: "Guardei meu código num lugar seguro" })),
        pronto));
    window.scrollTo(0, 0);
  }

  function desenharContaConectada(est) {
    var novo = el("button", { type: "button", class: "btn btn-contorno btn-bloco", text: "Gerar novo código de recuperação" });
    novo.addEventListener("click", function () {
      if (!window.confirm("Gerar um código novo? O código antigo deixa de valer.")) return;
      CT.novoCodigo().then(function (r) { desenharCodigo(r.codigo, "Novo código de recuperação"); }, function (e) { avisar(mensagemConta(e)); });
    });
    var sair = el("button", { type: "button", class: "btn btn-contorno btn-bloco", text: "Sair da conta" });
    sair.addEventListener("click", function () {
      if (!window.confirm("Sair da conta neste aparelho? Seus pontos continuam salvos; para vê-los de novo, é só entrar.")) return;
      encerrarViagemAntes();
      CT.sair().then(function () { avisar("Você saiu da conta."); location.hash = "#/perfil"; });
    });
    preencher($("#conta-conteudo"),
      el("div", { class: "card conta-intro" },
        el("span", { class: "conta-chamada-icone ok" }, icone("escudo", 24)),
        el("div", {},
          el("h2", { text: "Conectado como " + est.usuario }),
          el("p", { text: "Seus pontos, conquistas e posição no ranking ficam salvos nesta conta. Em outro celular, é só entrar com o mesmo usuário e senha." }))),
      el("div", { class: "card conta-acoes" },
        el("a", { class: "btn btn-primario btn-bloco", href: "#/meus-pontos" }, "Ver meus pontos"),
        novo, sair),
      el("p", { class: "nota", text: "Para apagar a conta e todos os dados dela, use “Excluir minha conta e meus dados” em Perfil → Privacidade." }),
      notaDemoConta());
  }

  // Perfil: nome, chamada "Salve seus pontos" e texto do botão de exclusão.
  function atualizarPerfilConta() {
    CT.estado().then(function (est) {
      var cadastrada = est.tipo === "cadastrada";
      $("#perfil-conta").textContent = cadastrada ? est.usuario : "";
      $("#perfil-sub").textContent = cadastrada ? "Conta " + est.usuario + " · pontos salvos" : "Você usa o Dá sinal sem cadastro.";
      $("#btn-excluir-dados").textContent = cadastrada ? "Excluir minha conta e meus dados" : "Excluir meus dados de viagem";
      S.pontos.resumo().then(function (r) {
        $("#perfil-salvar").hidden = cadastrada || !(r.pontosTotal > 0);
        $("#perfil-nome").textContent = r.perfil.apelido || (cadastrada ? est.usuario : "Visitante");
      }, function () { $("#perfil-salvar").hidden = true; });
    });
  }

  CT.aoMudar(function () {
    if (telaAtual === "perfil") abrirPerfil();
    if (telaAtual === "meus-pontos") abrirMeusPontos();
  });

  // ---------- Alarme de ponto ----------
  // Um alarme por aparelho, guardado neste navegador. Enquanto o app está
  // aberto, acompanha a posição do ônibus e avisa quando ele se aproxima.

  var alarme = lerLocal("dasinal.alarme", null);
  var monitor = { cancelar: null, versao: 0, disparado: false };
  var audio = null;

  function atualizarSino() {
    $("#home-sino .sino-ponto").hidden = !(alarme && alarme.ativo);
  }

  function tocarSom() {
    if (!audio) return;
    try {
      if (audio.state === "suspended") audio.resume();
      [0, 0.35, 0.7].forEach(function (atraso) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audio.currentTime + atraso);
        g.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + atraso + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + atraso + 0.25);
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + atraso);
        o.stop(audio.currentTime + atraso + 0.3);
      });
    } catch (e) { /* sem áudio */ }
  }

  function dispararAlarme(linha, ponto, faltam) {
    var texto = faltam === 0
      ? "Linha " + linha.numero + ": o próximo ponto do ônibus é o seu (" + ponto.nome + ")."
      : "Linha " + linha.numero + ": o ônibus está a " + faltam + (faltam === 1 ? " ponto" : " pontos") + " de " + ponto.nome + ".";
    avisar(texto, true);
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) { /* nada */ } }
    if (alarme.tipo === "som") tocarSom();
    if (window.Notification && Notification.permission === "granted") {
      try { new Notification("Dá sinal", { body: texto, icon: "logo.svg" }); } catch (e) { /* alguns celulares exigem service worker */ }
    }
  }

  function iniciarMonitor() {
    if (monitor.cancelar) { monitor.cancelar(); monitor.cancelar = null; }
    var versao = ++monitor.versao;
    atualizarSino();
    if (!alarme || !alarme.ativo) return;
    carregarLinhas().then(function (linhas) {
      var l = acharLinha(linhas, alarme.linhaId);
      if (!l) return null;
      return S.dados.listarPontos(l.id).then(function (pontos) {
        if (versao !== monitor.versao) return;
        var alvo = pontos.filter(function (p) { return String(p.id) === String(alarme.pontoId); })[0];
        if (!alvo) return;
        var ordem = {};
        pontos.forEach(function (p) { ordem[p.id] = p.ordem; });
        monitor.disparado = false;
        monitor.cancelar = S.posicao.assinar(l, pontos, function (pos) {
          if (!pos.proximoPonto || ordem[pos.proximoPonto.id] == null) return;
          var prox = ordem[pos.proximoPonto.id];
          var faltam = pos.sentido === "volta" ? prox - alvo.ordem : alvo.ordem - prox;
          // Na circular, um ponto que "já passou" chega na próxima volta.
          if (l.circular && faltam < 0) faltam += pontos.length;
          var dentro = faltam >= 0 && faltam <= alarme.antes;
          if (dentro && !monitor.disparado) { monitor.disparado = true; dispararAlarme(l, alvo, faltam); }
          else if (!dentro) monitor.disparado = false;
        });
      });
    }).catch(function () { /* tenta de novo na próxima abertura */ });
  }

  function preencherPontosAlarme(linhaId, pontoSelecionado) {
    var sel = $("#al-ponto");
    sel.replaceChildren(el("option", { value: "", text: "Carregando…" }));
    return S.dados.listarPontos(isNaN(Number(linhaId)) ? linhaId : Number(linhaId)).then(function (pontos) {
      sel.replaceChildren.apply(sel, pontos.map(function (p) {
        var o = el("option", { value: p.id, text: p.nome });
        if (String(p.id) === String(pontoSelecionado)) o.selected = true;
        return o;
      }));
    });
  }

  function abrirAlarme(linhaId) {
    var versao = mostrarTela("alarme");
    carregarLinhas().then(function (linhas) {
      if (versao !== versaoTela) return;
      var sel = $("#al-linha");
      var escolhida = linhaId != null ? linhaId : (alarme ? alarme.linhaId : linhas[0] && linhas[0].id);
      sel.replaceChildren.apply(sel, linhas.map(function (l) {
        var o = el("option", { value: l.id, text: "Linha " + l.numero + " – " + l.nome });
        if (String(l.id) === String(escolhida)) o.selected = true;
        return o;
      }));
      var mesmoAlarme = alarme && String(alarme.linhaId) === String(sel.value);
      preencherPontosAlarme(sel.value, mesmoAlarme ? alarme.pontoId : null);
      if (alarme) {
        $("#al-antes").value = String(alarme.antes);
        document.querySelector('input[name="al-tipo"][value="' + alarme.tipo + '"]').checked = true;
        $("#al-ativo").checked = !!alarme.ativo;
      }
    });
  }

  $("#al-linha").addEventListener("change", function () { preencherPontosAlarme(this.value, null); });

  $("#form-alarme").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!$("#al-ponto").value) { avisar("Escolha um ponto para o alarme."); return; }
    alarme = {
      linhaId: $("#al-linha").value,
      pontoId: $("#al-ponto").value,
      antes: Number($("#al-antes").value),
      tipo: document.querySelector('input[name="al-tipo"]:checked').value,
      ativo: $("#al-ativo").checked
    };
    gravarLocal("dasinal.alarme", alarme);

    // O som e a notificação precisam ser liberados a partir de um toque.
    if (alarme.tipo === "som" && !audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (err) { audio = null; }
    }
    if (alarme.ativo && alarme.tipo === "notificacao" && window.Notification && Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (err) { /* navegador antigo */ }
    }

    iniciarMonitor();
    avisar(alarme.ativo ? "Alarme salvo. Vamos avisar quando o ônibus estiver chegando." : "Alarme salvo e desativado.");
    location.hash = "#/";
  });

  // ---------- Rotas da página ----------

  function rotear() {
    var partes = (location.hash || "").replace(/^#\/?/, "").split("/");
    var p = partes[0];
    if (!p || p === "home") abrirHome();
    else if (p === "linhas") abrirLinhas(partes[1]);
    else if (p === "linha" && partes[1]) abrirLinha(partes[1], partes[2]);
    else if (p === "mapa") abrirMapa(partes[1] || null, partes[2] || null);
    else if (p === "pontos") abrirPontos();
    else if (p === "perfil") abrirPerfil();
    else if (p === "alarme") abrirAlarme(partes[1] || null);
    else if (p === "meus-pontos") abrirMeusPontos();
    else if (p === "conta") abrirConta(partes[1]);
    else abrirHome();
  }

  // ---------- Inicialização ----------

  injetarIcones();

  var splash = $("#splash");
  var jaAbriu = false;
  try { jaAbriu = !!window.sessionStorage.getItem("dasinal.splash"); window.sessionStorage.setItem("dasinal.splash", "1"); } catch (e) { /* segue */ }
  var reduzido = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(function () {
    splash.classList.add("saindo");
    setTimeout(function () { splash.remove(); }, 500);
  }, jaAbriu || reduzido ? 0 : 1300);

  if (S.modo === "demo") $("#selo-modo").hidden = false;
  if (S.modo === "demo" || S.posicao.simulada) {
    var textoDemo = S.modo === "demo"
      ? "Versão de demonstração: as rotas e as posições dos ônibus são fictícias."
      : "As posições dos ônibus são simuladas para demonstração.";
    ["#nota-demo", "#nota-demo-perfil"].forEach(function (s) { $(s).textContent = textoDemo; $(s).hidden = false; });
  }

  S.eventos.registrarAcessoUmaVez();
  iniciarMonitor();
  atualizarFaixaViagem(S.viagem.atual());
  var interrompida = S.viagem.interrompida();
  if (interrompida) {
    avisar("Sua viagem na linha " + interrompida.linhaNumero + " foi interrompida quando o app fechou. " +
      "Toque em “Estou neste ônibus” para voltar a compartilhar.", true);
  }
  window.addEventListener("hashchange", rotear);
  rotear();
})();
