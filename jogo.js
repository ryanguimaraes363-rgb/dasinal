/*
  "Motorista do Dá Sinal": joguinho para a pessoa ficar com o app aberto durante a
  viagem (com a tela bloqueada o navegador para de ler a localização).

  Abre em tela cheia POR CIMA do app, sem trocar de página: a coleta de
  localização (viagem.js) continua rodando por baixo. Só fica disponível durante
  uma viagem compartilhada; se a viagem acaba, o jogo fecha.

  Não usa internet durante a partida e NÃO dá pontos do app (senão seria o jeito
  mais fácil de subir de nível sem ajudar ninguém). O recorde fica só no aparelho.

  Interface: window.DaSinalJogo
    abrir()                 abre o jogo (tela de início)
    fechar()                fecha e para a animação
    viagem(v, texto)        chamado pelo app a cada mudança da viagem (v nulo = acabou)
    recorde()               melhor pontuação neste aparelho
    aoPedirSaida(fn)        fn é chamada quando a pessoa toca em "Saí do ônibus" dentro do jogo
*/
window.DaSinalJogo = (function () {
  "use strict";

  var L = 360, A = 640;                       // tamanho lógico do jogo
  var FAIXAS = [84, 180, 276];                // centro de cada faixa
  var Y_ONIBUS = A - 150;
  var DURACAO = 90, BATIDAS = 3;
  var CHAVE = "dasinal.jogo.recorde";
  var POSES = { correndo: "assistente-correndo.png", feliz: "assistente-ideia.png", bravo: "assistente-bravo.png", ola: "assistente-ola.png" };
  var FALAS_BOA = ["Boa!", "Sobe aí!", "Mais um!", "Isso!", "Valeu!"], FALAS_AI = ["Ai!", "Cuidado!", "Opa!"];

  var raiz = null, cv, g, rosto, E, quadroId = null, ultimo = 0, voltaAmigo = null, pedirSaida = null;
  function q(s) { return raiz.querySelector(s); }

  function montar() {
    if (raiz) return;
    raiz = document.createElement("div");
    raiz.className = "jg";
    raiz.hidden = true;
    raiz.setAttribute("role", "dialog");
    raiz.setAttribute("aria-label", "Jogo: Motorista do Dá Sinal");
    raiz.innerHTML =
      '<div class="jg-barra">' +
        '<button type="button" class="jg-x" aria-label="Fechar o jogo">×</button>' +
        '<span class="jg-viagem" role="status"></span>' +
        '<button type="button" class="btn btn-amarelo btn-pequeno jg-sair">Saí do ônibus</button>' +
      '</div>' +
      '<div class="jg-caixa">' +
        '<canvas width="360" height="640"></canvas>' +
        '<div class="jg-hud" hidden>' +
          '<div class="jg-placa">Pontos<b class="jg-pontos">0</b></div>' +
          '<div class="jg-placa">Tempo<b class="jg-tempo">90</b></div>' +
          '<div class="jg-placa">Batidas<b class="jg-vidas">●●●</b></div>' +
        '</div>' +
        '<div class="jg-amigo" hidden><img alt=""><span class="jg-fala"></span></div>' +
        '<div class="jg-tela jg-inicio">' +
          '<img src="assistente-ola.png" alt="">' +
          '<h2>Motorista do <span>Dá Sinal</span></h2>' +
          '<ul><li>Toque à esquerda ou à direita para mudar de faixa</li><li>Pegue os passageiros que dão sinal</li><li>Desvie dos buracos e dos cones</li></ul>' +
          '<button type="button" class="jg-btn jg-comecar">Começar</button>' +
          '<p class="jg-nota jg-rec"></p>' +
          '<p class="jg-nota">Com o jogo aberto, o ônibus continua aparecendo no mapa para quem está no ponto.</p>' +
        '</div>' +
        '<div class="jg-tela jg-fim" hidden>' +
          '<img class="jg-fim-img" src="assistente-ideia.png" alt="">' +
          '<h2 class="jg-fim-titulo">Fim da viagem!</h2>' +
          '<div class="jg-brilhos" hidden><span>✦</span><span>✦</span><span>✦</span></div>' +
          '<div class="jg-numero">0</div>' +
          '<p class="jg-fim-detalhe"></p>' +
          '<button type="button" class="jg-btn jg-de-novo">Jogar de novo</button>' +
          '<p class="jg-nota">O recorde fica guardado só neste aparelho.</p>' +
        '</div>' +
      '</div>';
    document.body.append(raiz);
    cv = q("canvas"); g = cv.getContext("2d");
    rosto = new Image(); rosto.src = "assistente-rosto.png";
    Object.keys(POSES).forEach(function (k) { var i = new Image(); i.src = POSES[k]; }); // já deixa carregadas

    cv.addEventListener("pointerdown", function (e) {
      var r = cv.getBoundingClientRect();
      mudar(e.clientX - r.left < r.width / 2 ? -1 : 1);
    });
    q(".jg-comecar").addEventListener("click", comecar);
    q(".jg-de-novo").addEventListener("click", comecar);
    q(".jg-x").addEventListener("click", fechar);
    q(".jg-sair").addEventListener("click", function () { if (pedirSaida) pedirSaida(); fechar(); });
    document.addEventListener("keydown", function (e) {
      if (!raiz || raiz.hidden) return;
      if (e.key === "ArrowLeft") mudar(-1);
      else if (e.key === "ArrowRight") mudar(1);
      else if (e.key === "Escape") fechar();
    });
    window.addEventListener("resize", function () { if (raiz && !raiz.hidden) ajustar(); });
    // Saiu da tela no meio da partida: o tempo do jogo não corre escondido.
    document.addEventListener("visibilitychange", function () { ultimo = 0; });
    nova();
  }

  function ajustar() {                        // nitidez em telas de alta densidade
    var r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (!r.width) return;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    g.setTransform(cv.width / L, 0, 0, cv.height / A, 0, 0);
  }

  function nova() {
    E = { rodando: false, t: 0, dist: 0, vel: 220, faixa: 1, x: FAIXAS[1], pass: 0, batidas: 0, imune: 0, treme: 0,
      objs: [], proxLinha: 260, flutua: [], semente: 1 };
  }
  function sorteio() { E.semente = (E.semente * 16807) % 2147483647; return (E.semente - 1) / 2147483646; }
  function pontos() { return E.pass * 10 + Math.floor(E.dist / 60); }
  function recorde() { try { return Number(window.localStorage.getItem(CHAVE)) || 0; } catch (e) { return 0; } }

  // ---------- Personagem ----------
  // classe: "feliz" | "bravo" | "aceno". Depois de "ms" ele volta a correr.
  function reagir(classe, pose, texto, ms) {
    var amigo = q(".jg-amigo");
    q(".jg-amigo img").src = POSES[pose]; q(".jg-fala").textContent = texto;
    amigo.className = "jg-amigo"; void amigo.offsetWidth; amigo.className = "jg-amigo " + classe; // reinicia a animação
    clearTimeout(voltaAmigo);
    voltaAmigo = setTimeout(function () {
      if (E.rodando) { q(".jg-amigo img").src = POSES.correndo; amigo.className = "jg-amigo correndo"; }
    }, ms || 1150);
  }

  // Uma "linha" de coisas na pista: nunca fecha as três faixas.
  function novaLinha() {
    var livre = Math.floor(sorteio() * 3), r = sorteio();
    if (r < 0.42) {                           // passageiro dando sinal
      E.objs.push({ tipo: "passageiro", faixa: Math.floor(sorteio() * 3), y: -60 });
    } else {
      var qtd = E.t > 40 && sorteio() < 0.4 ? 2 : 1, usadas = {};   // dois obstáculos só depois de 40 s
      for (var i = 0; i < qtd; i++) {
        var f = Math.floor(sorteio() * 3);
        if (f === livre || usadas[f]) continue;
        usadas[f] = true;
        E.objs.push({ tipo: sorteio() < 0.5 ? "buraco" : "cone", faixa: f, y: -60 });
      }
      if (sorteio() < 0.3) E.objs.push({ tipo: "passageiro", faixa: livre, y: -60 });
    }
  }

  function passo(dt) {
    if (!E.rodando) return;
    E.t += dt;
    E.vel = Math.min(480, 220 + E.t * 2.6);   // acelera aos poucos
    var d = E.vel * dt;
    E.dist += d;
    E.x += (FAIXAS[E.faixa] - E.x) * Math.min(1, dt * 14);
    if (E.imune > 0) E.imune -= dt;
    if (E.treme > 0) E.treme -= dt;
    E.proxLinha -= d;
    if (E.proxLinha <= 0) { novaLinha(); E.proxLinha = Math.max(150, 250 - E.t * 0.9) + sorteio() * 70; }

    E.objs.forEach(function (o) {
      o.y += d;
      if (o.pego || Math.abs(o.y - Y_ONIBUS) > 52 || Math.abs(FAIXAS[o.faixa] - E.x) > 44) return;
      if (o.tipo === "passageiro") {
        o.pego = true; E.pass++;
        E.flutua.push({ x: FAIXAS[o.faixa], y: Y_ONIBUS - 60, vida: 0.9, texto: "+10" });
        reagir("feliz", "feliz", E.pass % 10 === 0 ? E.pass + " passageiros!" : FALAS_BOA[E.pass % FALAS_BOA.length]);
      } else if (E.imune <= 0) {
        o.pego = true; E.batidas++; E.imune = 1.3; E.treme = 0.35;
        reagir("bravo", "bravo", FALAS_AI[E.batidas % FALAS_AI.length], 1300);
        if (navigator.vibrate) { try { navigator.vibrate(120); } catch (e) { /* sem vibração */ } }
      }
    });
    E.objs = E.objs.filter(function (o) { return o.y < A + 80 && !(o.pego && o.tipo === "passageiro"); });
    E.flutua.forEach(function (f) { f.vida -= dt; f.y -= 60 * dt; });
    E.flutua = E.flutua.filter(function (f) { return f.vida > 0; });
    if (E.batidas >= BATIDAS || E.t >= DURACAO) terminar();
  }

  // ---------- Desenho ----------
  function caixa(x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.closePath(); }

  function desenhar() {
    var sx = E.treme > 0 ? (Math.sin(E.t * 90) * 5) : 0;
    g.save(); g.translate(sx, 0);
    g.fillStyle = "#03213B"; g.fillRect(-10, 0, L + 20, A);                 // calçada
    g.fillStyle = "#39445A"; g.fillRect(36, 0, L - 72, A);                  // pista
    g.fillStyle = "#FFB71B"; g.fillRect(36, 0, 5, A); g.fillRect(L - 41, 0, 5, A);
    g.fillStyle = "rgba(255,255,255,.75)";                                  // faixas tracejadas correndo
    var desloc = E.dist % 60;
    for (var y = -60 + desloc; y < A; y += 60) { g.fillRect(130, y, 5, 30); g.fillRect(226, y, 5, 30); }
    g.fillStyle = "rgba(255,255,255,.10)";                                  // marcas na calçada, para dar velocidade
    for (var p = -120 + (E.dist % 120); p < A; p += 120) { g.fillRect(12, p, 12, 12); g.fillRect(L - 24, p + 60, 12, 12); }

    E.objs.forEach(function (o) {
      var x = FAIXAS[o.faixa];
      if (o.tipo === "buraco") {
        g.fillStyle = "#151B26"; g.beginPath(); g.ellipse(x, o.y, 30, 19, 0, 0, 7); g.fill();
        g.fillStyle = "#0A0E15"; g.beginPath(); g.ellipse(x - 3, o.y + 2, 19, 11, 0, 0, 7); g.fill();
      } else if (o.tipo === "cone") {
        g.fillStyle = "#FF6A2B"; g.beginPath(); g.moveTo(x, o.y - 26); g.lineTo(x + 17, o.y + 16); g.lineTo(x - 17, o.y + 16); g.closePath(); g.fill();
        g.fillStyle = "#fff"; g.fillRect(x - 10, o.y - 2, 20, 6);
        g.fillStyle = "#C94A12"; caixa(x - 22, o.y + 14, 44, 8, 3); g.fill();
      } else {                                                              // passageiro dando sinal
        g.fillStyle = "#FFB71B"; caixa(x + 16, o.y - 40, 22, 16, 4); g.fill();
        g.fillStyle = "#C9D3E3"; g.fillRect(x + 25, o.y - 26, 4, 46);
        g.fillStyle = "#F7F9FF"; g.beginPath(); g.arc(x - 6, o.y - 16, 10, 0, 7); g.fill();
        caixa(x - 16, o.y - 5, 20, 28, 9); g.fill();
        g.strokeStyle = "#F7F9FF"; g.lineWidth = 5; g.lineCap = "round";
        g.beginPath(); g.moveTo(x + 2, o.y + 2); g.lineTo(x + 14, o.y - 12 + Math.sin(E.t * 9) * 4); g.stroke();
      }
    });

    // Ônibus (visto de cima) com o personagem no para-brisa.
    var bx = E.x, by = Y_ONIBUS, pisca = E.imune > 0 && Math.floor(E.t * 12) % 2 === 0;
    g.globalAlpha = pisca ? 0.35 : 1;
    g.fillStyle = "rgba(0,0,0,.28)"; caixa(bx - 30, by - 50, 66, 112, 14); g.fill();
    g.fillStyle = "#FFB71B"; caixa(bx - 32, by - 56, 64, 112, 14); g.fill();
    g.fillStyle = "#E09A00"; caixa(bx - 24, by - 12, 48, 58, 8); g.fill();
    g.fillStyle = "#0B2447"; caixa(bx - 25, by - 49, 50, 32, 8); g.fill();     // para-brisa
    g.fillStyle = "#fff"; g.beginPath(); g.arc(bx, by - 33, 13, 0, 7); g.fill();
    if (rosto.complete && rosto.naturalWidth) {
      // A cabeça balança com o motor, inclina ao trocar de faixa e chacoalha na batida.
      var inclina = Math.max(-0.5, Math.min(0.5, (FAIXAS[E.faixa] - E.x) * 0.014)) + (E.imune > 0 ? Math.sin(E.t * 40) * 0.25 : 0);
      g.save(); g.translate(bx, by - 32 + Math.sin(E.t * 11) * 1.4); g.rotate(inclina); g.drawImage(rosto, -15, -15, 30, 30); g.restore();
    }
    g.fillStyle = "#FFF6DF"; caixa(bx - 28, by - 60, 12, 6, 3); g.fill(); caixa(bx + 16, by - 60, 12, 6, 3); g.fill(); // faróis
    g.fillStyle = "#0B2447"; g.fillRect(bx - 36, by - 30, 5, 18); g.fillRect(bx + 31, by - 30, 5, 18); g.fillRect(bx - 36, by + 24, 5, 18); g.fillRect(bx + 31, by + 24, 5, 18);
    g.globalAlpha = 1;

    g.font = "900 22px system-ui, sans-serif"; g.textAlign = "center";
    E.flutua.forEach(function (f) { g.globalAlpha = Math.min(1, f.vida * 2); g.fillStyle = "#FFB71B"; g.fillText(f.texto, f.x, f.y); });
    g.globalAlpha = 1;
    g.restore();

    q(".jg-pontos").textContent = String(pontos());
    q(".jg-tempo").textContent = String(Math.max(0, Math.ceil(DURACAO - E.t)));
    var v = ""; for (var i = 0; i < BATIDAS; i++) v += i < BATIDAS - E.batidas ? "●" : "○";
    q(".jg-vidas").textContent = v;
  }

  // ---------- Partida ----------
  function comecar() {
    nova(); E.semente = (Date.now() % 2147483646) + 1; E.rodando = true;
    q(".jg-inicio").hidden = true; q(".jg-fim").hidden = true; q(".jg-hud").hidden = false;
    q(".jg-amigo").hidden = false; reagir("aceno", "ola", "Vamos lá!", 1200);
    ultimo = 0;
  }
  function terminar() {
    E.rodando = false;
    var p = pontos(), r = recorde(), novo = p > r, quebrou = E.batidas >= BATIDAS;
    if (novo) { try { window.localStorage.setItem(CHAVE, String(p)); } catch (e) { /* sem armazenamento */ } }
    q(".jg-fim-titulo").textContent = quebrou ? "O ônibus quebrou!" : "Chegou ao ponto final!";
    q(".jg-numero").textContent = String(p);
    q(".jg-fim-detalhe").textContent = E.pass + (E.pass === 1 ? " passageiro" : " passageiros") + " · " + (novo ? "novo recorde!" : "recorde: " + r);
    // Cada final tem a sua pose: recorde (brilhos), chegou (comemora) ou quebrou (bravo, tremendo).
    var img = q(".jg-fim-img");
    img.src = quebrou ? POSES.bravo : novo ? POSES.feliz : POSES.ola;
    img.className = "jg-fim-img"; void img.offsetWidth; img.className = "jg-fim-img " + (quebrou ? "quebrou" : novo ? "recorde" : "comemora");
    q(".jg-brilhos").hidden = !(novo && !quebrou);
    clearTimeout(voltaAmigo); q(".jg-amigo").hidden = true;
    q(".jg-fim").hidden = false; q(".jg-hud").hidden = true;
  }
  function mudar(d) { if (E.rodando) E.faixa = Math.max(0, Math.min(2, E.faixa + d)); }

  function quadro(agora) {
    var dt = ultimo ? Math.min(0.05, (agora - ultimo) / 1000) : 0;
    ultimo = agora;
    passo(dt); desenhar();
    quadroId = window.requestAnimationFrame(quadro);
  }

  function abrir() {
    montar();
    if (!raiz.hidden) return;
    nova();
    var rec = recorde();
    q(".jg-rec").textContent = rec ? "Seu recorde: " + rec + " pontos" : "";
    q(".jg-inicio").hidden = false; q(".jg-fim").hidden = true; q(".jg-hud").hidden = true; q(".jg-amigo").hidden = true;
    raiz.hidden = false;
    document.body.classList.add("com-jogo");
    ajustar(); desenhar();
    ultimo = 0; quadroId = window.requestAnimationFrame(quadro);
    q(".jg-comecar").focus();
  }
  function fechar() {
    if (!raiz || raiz.hidden) return;
    E.rodando = false;
    clearTimeout(voltaAmigo);
    if (quadroId != null) { window.cancelAnimationFrame(quadroId); quadroId = null; } // sem jogo aberto, não gasta bateria
    raiz.hidden = true;
    document.body.classList.remove("com-jogo");
  }

  return {
    abrir: abrir,
    fechar: fechar,
    recorde: recorde,
    aoPedirSaida: function (fn) { pedirSaida = fn; },
    // v: viagem atual (ou null quando acabou); texto: a situação já em palavras.
    viagem: function (v, texto) {
      if (!raiz) return;
      if (!v) { fechar(); return; }
      q(".jg-viagem").textContent = "Linha " + v.linhaNumero + " · " + (texto || "compartilhando");
    },
    // Só para os testes automáticos (o navegador sem tela não roda a animação sozinho).
    _teste: { comecar: function () { montar(); comecar(); }, passo: passo, desenhar: desenhar, estado: function () { return E; }, pontos: pontos }
  };
})();
