'use strict';

/**
 * Porte de executarRodadaPedidosDasReservas_() do .gs original: orquestra
 * uma rodada completa (Estoque -> Reservas x Pedidos -> Dashboard de
 * Separação), usando as funções puras de reservasLogica.js pro cálculo em
 * si e sheetsClient/orgmClient pro I/O.
 *
 * Diferença em relação ao original: não existe mais LockService aqui -
 * quem evita duas rodadas simultâneas é o "concurrency group" do próprio
 * workflow do GitHub Actions (ver .github/workflows/tempo-real.yml), que é
 * o equivalente nativo e mais simples nesse ambiente.
 */

const orgm = require('./orgmClient');
const { colIndexToLetter } = require('./sheetsClient');
const { executarAtualizacaoDeEstoque } = require('./estoque');
const { carregarEstadoConferidoPorBin, salvarEstadoConferidoPorBin } = require('./estadoReservas');
const {
  COLUNAS_RESERVAS,
  construirMapasEstoque,
  calcularBinsParaConsultar,
  podarBinsNaoReservados,
  atualizarLocalDeTodosOsBins,
  aplicarResultadoLote,
} = require('./reservasLogica');
const { sleep, agoraBrasilia } = require('./util');

const NOME_ABA_RESERVAS = 'Reservas x Pedidos';

// Tempo máximo que a busca de reservas roda antes de parar e escrever o que
// já tiver, pra cada execução do workflow ficar curta e previsível (evita
// rodadas se acumulando na fila do GitHub Actions). O que ficar de fora
// continua "precisa conferir" na próxima rodada.
const LIMITE_TEMPO_BUSCA_RESERVAS_MS = Number(process.env.LIMITE_TEMPO_BUSCA_RESERVAS_MS) || 4 * 60 * 1000;

function a1Range(row1, col1, numRows, numCols) {
  const c1 = colIndexToLetter(col1 - 1);
  const c2 = colIndexToLetter(col1 - 1 + numCols - 1);
  return `${c1}${row1}:${c2}${row1 + numRows - 1}`;
}

async function executarRodadaPedidosDasReservas(sheetsClient) {
  try {
    await executarAtualizacaoDeEstoque(sheetsClient);
    // Roda o dashboard de estoque junto, igual atualizarEstoque() fazia no .gs.
    try {
      await require('./dashboard').criarDashboard(sheetsClient);
    } catch (e) {
      console.log('Erro ao atualizar o Dashboard de Estoque: ' + e);
    }
  } catch (e) {
    console.log('Falha ao atualizar o Estoque antes de buscar as reservas: ' + e);
  }

  const dadosEstoque = await sheetsClient.getValues('Estoque');
  if (!dadosEstoque.length || dadosEstoque.length < 2) {
    console.log('executarRodadaPedidosDasReservas: abortado, aba "Estoque" vazia ou inexistente.');
    return { abortado: true, motivo: 'estoque_vazio' };
  }

  const cabecalhoEstoque = dadosEstoque[0];
  const linhasEstoque = dadosEstoque.slice(1);
  const idx = {
    bin: cabecalhoEstoque.indexOf('BIN'),
    reservado: cabecalhoEstoque.indexOf('Reservado'),
    almoxarifado: cabecalhoEstoque.indexOf('Almoxarifado'),
    local: cabecalhoEstoque.indexOf('Local'),
  };
  if (idx.bin < 0) idx.bin = 1;
  if (idx.reservado < 0) idx.reservado = 6;
  if (idx.almoxarifado < 0) idx.almoxarifado = 0;
  if (idx.local < 0) idx.local = 2;

  // localPorBin vem do Estoque (reexportado a cada rodada direto da ORGM) -
  // é a fonte de verdade do endereço físico atual do BIN, ao contrário do
  // Local que a busca "Bin Historico" devolve (esse fica desatualizado
  // quando o BIN é movido pra um endereço de separação, Z...). Ver comentário
  // completo em reservasLogica.js.
  const { almoxarifadoPorBin, localPorBin, reservadoPorBinComEstoque, binsReservados, listaBins } =
    construirMapasEstoque(linhasEstoque, idx);

  if (!listaBins.length) {
    console.log('executarRodadaPedidosDasReservas: abortado, nenhum BIN com Reservado > 0.');
    return { abortado: true, motivo: 'sem_bins_reservados' };
  }

  let estadoConferidoPorBin = await carregarEstadoConferidoPorBin(sheetsClient);
  estadoConferidoPorBin = podarBinsNaoReservados(estadoConferidoPorBin, binsReservados);

  const colunas = COLUNAS_RESERVAS;
  await sheetsClient.ensureSheet(NOME_ABA_RESERVAS);

  // Verifica se o cabeçalho salvo (linha 4) ainda bate com "colunas" - tanto
  // no conteúdo quanto na QUANTIDADE de colunas. Importante checar o
  // tamanho: se "colunas" mudar (por ex. uma coluna for removida, como
  // aconteceu com "LocalFisico"), comparar só o conteúdo das primeiras N
  // posições dava "válido" mesmo com o cabeçalho antigo tendo colunas extras
  // sobrando - aí linhas antigas (mais longas) ficavam misturadas com linhas
  // novas (mais curtas) no upsert por BIN abaixo, e o Sheets rejeitava a
  // escrita inteira por causa da linha desalinhada.
  const dadosReservas = await sheetsClient.getValues(NOME_ABA_RESERVAS);
  let cabecalhoValido = false;
  if (dadosReservas.length >= 4) {
    const cabecalhoAtual = dadosReservas[3] || [];
    cabecalhoValido =
      cabecalhoAtual.length === colunas.length && colunas.every((col, i) => cabecalhoAtual[i] === col);
  }
  if (!cabecalhoValido) {
    await sheetsClient.clearValues(NOME_ABA_RESERVAS);
    estadoConferidoPorBin = {};
  }

  // Upsert por BIN: carrega o que já existe (linha 5 em diante) num mapa,
  // pra só substituir a entrada do BIN que for reconsultado nesta rodada -
  // nunca um wipe cego do resto.
  const mapaLinhasPorBin = {};
  if (cabecalhoValido && dadosReservas.length > 4) {
    for (let i = 4; i < dadosReservas.length; i++) {
      // Corta/preenche pra ter sempre exatamente "colunas.length" células -
      // proteção extra pro Sheets nunca receber linhas de tamanhos
      // diferentes numa mesma escrita (o que faz a API rejeitar tudo).
      const linha = dadosReservas[i].slice(0, colunas.length);
      while (linha.length < colunas.length) linha.push('');
      const chaveBinExistente = String(linha[1]); // coluna B = BIN
      if (!mapaLinhasPorBin[chaveBinExistente]) mapaLinhasPorBin[chaveBinExistente] = [];
      mapaLinhasPorBin[chaveBinExistente].push(linha);
    }
  }
  podarBinsNaoReservados(mapaLinhasPorBin, binsReservados);

  await sheetsClient.setValues(NOME_ABA_RESERVAS, 'A1:B1', [['Reservas x Pedidos (Ordem de Venda) - por BIN', '']]);
  await sheetsClient.setValues(NOME_ABA_RESERVAS, 'A2:B2', [['Atualizado em:', agoraBrasilia()]]);
  await sheetsClient.setValues(NOME_ABA_RESERVAS, a1Range(4, 1, 1, colunas.length), [colunas]);
  const sheetIdReservas = await sheetsClient.getSheetId(NOME_ABA_RESERVAS);
  await sheetsClient.setFont(sheetIdReservas, 0, 0, 1, 1, { size: 14, bold: true });
  await sheetsClient.setFont(sheetIdReservas, 3, 0, 1, colunas.length, { bold: true });

  const binsParaConsultar = calcularBinsParaConsultar(listaBins, estadoConferidoPorBin, reservadoPorBinComEstoque);

  const inicioExecucao = Date.now();
  let binsProcessados = 0;
  let reservasEncontradasNestaExecucao = 0;
  let binsSemReservaAtivaEncontrada = 0;
  let falhaGeral = false;
  const avisosDiscrepancia = [];

  for (let i = 0; i < binsParaConsultar.length; ) {
    if (Date.now() - inicioExecucao > LIMITE_TEMPO_BUSCA_RESERVAS_MS) break;
    const fimLote = Math.min(i + orgm.TAMANHO_LOTE_BUSCA_RESERVAS, binsParaConsultar.length);
    const loteBins = binsParaConsultar.slice(i, fimLote);
    try {
      const resultadosLote = await orgm.buscarReservasDeVariosBins(loteBins);
      const { reservasEncontradas, binsSemReservaAtiva, avisos } = aplicarResultadoLote({
        resultadosLote,
        loteBins,
        almoxarifadoPorBin,
        localPorBin,
        reservadoPorBinComEstoque,
        mapaLinhasPorBin,
        estadoConferidoPorBin,
        colunas,
      });
      reservasEncontradasNestaExecucao += reservasEncontradas;
      binsSemReservaAtivaEncontrada += binsSemReservaAtiva;
      avisosDiscrepancia.push(...avisos);
    } catch (e) {
      // Não loga o número do BIN nem quantidades aqui de propósito: se o
      // repositório for público, os logs de cada execução do GitHub Actions
      // também são públicos - só o tamanho do lote fica no log, nunca dado
      // de estoque/reserva.
      console.log('Falha num lote de ' + loteBins.length + ' BIN(s): ' + (e && e.message ? e.message : e));
      if (e && e.loteInteiroFalhou) {
        // Lote inteiro falhou (ORGM fora do ar, rede, etc.) - para a rodada
        // por completo aqui; os BINs que ainda precisavam ser conferidos
        // continuam na fila pra próxima rodada agendada.
        falhaGeral = true;
        break;
      }
    }
    binsProcessados += loteBins.length;
    i = fimLote;
    await sleep(200);
  }

  await salvarEstadoConferidoPorBin(sheetsClient, estadoConferidoPorBin);

  // Atualiza Almoxarifado/Local de TODOS os BINs já existentes em
  // mapaLinhasPorBin - não só dos que foram reconsultados na ORGM nesta
  // rodada acima. Isso cobre o caso normal de um BIN ser fisicamente movido
  // pra um endereço de separação (Z...) SEM a quantidade reservada mudar:
  // sem este passo, esse BIN nunca seria selecionado por
  // calcularBinsParaConsultar (que só olha a quantidade) e seu Local ficaria
  // congelado pra sempre. O Estoque já é reexportado do zero a cada rodada,
  // então almoxarifadoPorBin/localPorBin já estão atualizados de graça, sem
  // nenhuma chamada extra à ORGM.
  atualizarLocalDeTodosOsBins(mapaLinhasPorBin, almoxarifadoPorBin, localPorBin, colunas);

  const backlogRestante = Math.max(0, binsParaConsultar.length - binsProcessados);
  const terminouTudo = backlogRestante === 0 && !falhaGeral;

  const linhasFinais = [];
  Object.keys(mapaLinhasPorBin)
    .sort()
    .forEach((chaveBin) => {
      mapaLinhasPorBin[chaveBin].forEach((linha) => linhasFinais.push(linha));
    });

  if (dadosReservas.length > 4) {
    await sheetsClient.clearValues(NOME_ABA_RESERVAS, a1Range(5, 1, dadosReservas.length - 4, colunas.length));
  }
  if (linhasFinais.length) {
    await sheetsClient.setValues(NOME_ABA_RESERVAS, a1Range(5, 1, linhasFinais.length, colunas.length), linhasFinais);
  }
  await sheetsClient.autoResizeColumns(sheetIdReservas, 0, colunas.length);

  let mensagem =
    `BINs reservados no total: ${listaBins.length}\n` +
    `BINs que mudaram desde a última conferência: ${binsParaConsultar.length}\n` +
    `BINs conferidos nesta execução: ${binsProcessados}\n` +
    `Reservas ativas confirmadas nesta execução: ${reservasEncontradasNestaExecucao}\n` +
    `Total de linhas atualmente na aba "Reservas x Pedidos": ${linhasFinais.length}`;

  if (binsSemReservaAtivaEncontrada > 0) {
    mensagem += `\n\nAtenção: ${binsSemReservaAtivaEncontrada} BIN(s) consultados nesta execução aparecem com Reservado > 0 no Estoque, mas a busca do ORGM só trouxe reservas já baixadas (ou nenhuma) - vale conferir manualmente esses casos.`;
  }
  if (avisosDiscrepancia.length > 0) {
    // Só a contagem, nunca o detalhe (BIN/quantidade) - se o repositório for
    // público, o log desta execução também é público. O detalhe completo de
    // cada discrepância fica só na aba "Reservas x Pedidos" em si.
    mensagem += `\n\nAtenção: ${avisosDiscrepancia.length} BIN(s) com soma de reservas ativas diferente do Reservado no Estoque - vale conferir manualmente.`;
  }
  if (falhaGeral) {
    mensagem += `\n\nAtenção: um lote inteiro de consultas à ORGM falhou nesta execução (rede ou serviço indisponível). A rodada parou aqui de propósito - ainda restam ${backlogRestante} BIN(s) na fila, que continuam sendo retomados automaticamente na próxima rodada agendada.`;
  } else if (!terminouTudo) {
    mensagem += `\n\nAinda restam ${backlogRestante} BIN(s) na fila desta rodada por causa do tempo de execução - continuam sendo conferidos automaticamente na próxima rodada.`;
  } else {
    mensagem += '\n\nEm dia: todos os BINs que precisavam de conferência nesta rodada foram consultados.';
  }

  await sheetsClient.setValues(NOME_ABA_RESERVAS, 'A3:A3', [
    [
      (terminouTudo
        ? 'Status: em dia - nenhum BIN pendente de conferência'
        : `Status: ${backlogRestante} BIN(s) ainda pendente(s) de conferência` + (falhaGeral ? ' (falha de rede/ORGM)' : '')) +
        ` - última rodada em ${agoraBrasilia()}.`,
    ],
  ]);
  await sheetsClient.setFont(sheetIdReservas, 2, 0, 1, 1, { italic: true, color: '#666666' });

  // Importante: envia as escritas acumuladas de "Reservas x Pedidos" AGORA,
  // porque o Dashboard de Separação (chamado logo abaixo) faz um
  // getValues(NOME_ABA_RESERVAS) - sem esse flush, ele leria a aba
  // desatualizada (as escritas ficam só enfileiradas até flush()).
  await sheetsClient.flush();

  console.log(mensagem);

  try {
    await require('./dashboardSeparacao').criarDashboardSeparacao(sheetsClient);
  } catch (e) {
    console.log('Erro ao atualizar o Dashboard de Separação: ' + e);
  }

  return {
    abortado: false,
    listaBinsTotal: listaBins.length,
    binsParaConsultar: binsParaConsultar.length,
    binsProcessados,
    reservasEncontradasNestaExecucao,
    linhasFinais: linhasFinais.length,
    terminouTudo,
    falhaGeral,
    backlogRestante,
  };
}

module.exports = { executarRodadaPedidosDasReservas, NOME_ABA_RESERVAS };
