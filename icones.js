(function () {
  // Ícones de traço (usam a cor do texto ao redor).
  function traco(corpo, extra) {
    return function (tam) {
      var t = tam || 20;
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + t + '" height="' + t + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + (extra || "") + '>' + corpo + '</svg>';
    };
  }

  window.DaSinalIcones = {
    linhas: traco('<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/>'),
    seta: traco('<path d="M5 12h14"/><path d="m13 5 7 7-7 7"/>'),
    voltar: traco('<path d="m15 5-7 7 7 7"/>'),
    avancar: traco('<path d="m9 5 7 7-7 7"/>'),
    // Ônibus colorido (marca), usado em destaques.
    onibus: function (tam) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (tam || 20) + '" height="' + (tam || 20) + '" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="12" rx="3" fill="#FFB71B" stroke="#0B2447" stroke-width="1.5"/><path d="M5.5 9.5h13" stroke="#0B2447" stroke-width="1.5" stroke-linecap="round"/><circle cx="7.5" cy="18.5" r="1.8" fill="#0B2447"/><circle cx="16.5" cy="18.5" r="1.8" fill="#0B2447"/><rect x="6" y="6.5" width="12" height="4.5" rx="1.2" fill="#F7F9FF" opacity="0.9"/></svg>';
    },
    // Ônibus de traço (vista de frente), como no restante da interface.
    bus: traco('<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14"/><path d="M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r=".8" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".8" fill="currentColor"/>'),
    ponto: function (tam) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (tam || 20) + '" height="' + (tam || 20) + '" viewBox="0 0 24 24" fill="none"><path d="M12 21s7-5 7-11a7 7 0 1 0-14 0c0 6 7 11 7 11Z" fill="#0B2447"/><circle cx="12" cy="10" r="3.5" fill="#FFB71B"/></svg>';
    },
    pin: traco('<path d="M12 21s7-4.35 7-11a7 7 0 1 0-14 0c0 6.65 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5" fill="currentColor" stroke="none"/>'),
    busca: traco('<circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/>'),
    mapa: traco('<path d="M3 6.5 9 4l6 2.5 6-2.5v13l-6 2.5-6-2.5-6 2.5v-13Z"/><path d="M9 4v13M15 6.5v13"/>'),
    casa: traco('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9 20v-6h6v6"/>'),
    alvo: traco('<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    usuario: traco('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
    coracao: traco('<path d="M12 20s-7.5-4.6-9.2-9.4C1.6 7.1 3.9 4 7.2 4c2 0 3.5 1.1 4.8 2.8C13.3 5.1 14.8 4 16.8 4c3.3 0 5.6 3.1 4.4 6.6C19.5 15.4 12 20 12 20Z"/>'),
    coracaoCheio: traco('<path d="M12 20s-7.5-4.6-9.2-9.4C1.6 7.1 3.9 4 7.2 4c2 0 3.5 1.1 4.8 2.8C13.3 5.1 14.8 4 16.8 4c3.3 0 5.6 3.1 4.4 6.6C19.5 15.4 12 20 12 20Z" fill="currentColor"/>'),
    sino: traco('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    volume: traco('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4v-5Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    relogio: traco('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    escudo: traco('<path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>'),
    grafico: traco('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    info: traco('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>'),
    // Compartilhando a localização (ondas saindo de um ponto).
    sinal: traco('<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
    sair: traco('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m10 16-4-4 4-4"/><path d="M6 12h10"/>'),
    lista: traco('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>')
  };
})();
