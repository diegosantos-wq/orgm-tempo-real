'use strict';

/**
 * Funções puras (sem I/O) da lógica de "Reservas x Pedidos" - separadas de
 * reservas.js de propósito pra dar pra testar sem precisar de rede nem
 * credenciais (ver test/reservasLogica.test.js). Reproduzem exatamente os
 * dois bugs de negócio já corrigidos no .gs original:
 *   - BIN partido em mais de um Almoxarifado (usar o Almoxarifado da
 *     divisão que TEM reserva, e a soma real do Reservado);
 *   - quantidade "pela metade" (só contar reservas ativas, Baixado != 1,
 *     e nunca dividir a Qtde por nada).
 */

const COLUNAS_RESERVAS = [
  'Almoxarifado', 'BIN', 'Item', 'TipoPedido', 'Pedido', 'OrdemVenda',
  'OrdemProducao', 'PosicaoOP', 'Qtde', 'Baixado', 'wrkID', 'Local',
  'Lote_Interno', 'LocalFisico',
];

/**
 * A partir das linhas da aba "Estoque", monta:
 *   - almoxarifadoPorBin: BIN -> Almoxarifado da divisão que tem reserva
 *     (prioriza reservado > 0; se nenhuma divisão tiver, fica com a última vista)
 *   - reservadoPorBinComEstoque: BIN -> soma do Reservado em TODAS as divisões
 *   - binsReservados / listaBins: só BINs com Reservado > 0 em alguma divisão
 */
function construirMapasEstoque(linhasEstoque, idx) {
  const almoxarifadoPorBin = {};
  const reservadoPorBinComEstoque = {};
  const binsReservados = {};
  linhasEstoque.forEach((linha) => {
    const bin = linha[idx.bin];
    const reservado = Number(linha[idx.reservado]) || 0;
    if (bin !== '' && bin !== null && bin !== undefined) {
      const chaveBin = String(bin);
      if (almoxarifadoPorBin[chaveBin] === undefined || reservado > 0) {
        almoxarifadoPorBin[chaveBin] = linha[idx.almoxarifado];
      }
      reservadoPorBinComEstoque[chaveBin] = (reservadoPorBinComEstoque[chaveBin] || 0) + reservado;
    }
    if (bin !== '' && bin !== null && bin !== undefined && reservado > 0) {
      binsReservados[String(bin)] = true;
    }
  });
  const listaBins = Object.keys(binsReservados).sort();
  return { almoxarifadoPorBin, reservadoPorBinComEstoque, binsReservados, listaBins };
}

function calcularBinsParaConsultar(listaBins, estadoConferidoPorBin, reservadoPorBinComEstoque) {
  return listaBins.filter(
    (bin) => estadoConferidoPorBin[bin] === undefined || estadoConferidoPorBin[bin] !== reservadoPorBinComEstoque[bin]
  );
}

function podarBinsNaoReservados(mapa, binsReservados) {
  Object.keys(mapa).forEach((chave) => {
    if (!binsReservados[chave]) delete mapa[chave];
  });
  return mapa;
}

/**
 * Aplica o resultado (já resolvido, sem I/O) de um lote de BINs consultados,
 * mutando mapaLinhasPorBin e estadoConferidoPorBin in place. Devolve
 * estatísticas da rodada.
 */
function aplicarResultadoLote({
  resultadosLote,
  loteBins,
  almoxarifadoPorBin,
  reservadoPorBinComEstoque,
  mapaLinhasPorBin,
  estadoConferidoPorBin,
  colunas = COLUNAS_RESERVAS,
}) {
  let reservasEncontradas = 0;
  let binsSemReservaAtiva = 0;
  const avisos = [];

  resultadosLote.forEach((resultadoBin, idxBin) => {
    const chaveBinConsultado = String(loteBins[idxBin]);
    if (!resultadoBin.ok) {
      // Falha pontual (rede/HTTP/JSON) - não mexe no que já estava
      // confirmado antes, continua "precisa conferir" na próxima rodada.
      return;
    }

    // Baixado=1 => reserva já executada (histórico); só Baixado != 1 conta
    // como "aguardando separação" agora. A Qtde de cada reserva ativa vem
    // direto da ORGM, sem dividir por nada.
    const reservasAtivas = resultadoBin.linhas.filter((obj) => Number(obj.Baixado) !== 1);
    reservasEncontradas += reservasAtivas.length;
    if (resultadoBin.linhas.length && !reservasAtivas.length) {
      binsSemReservaAtiva++;
    }

    if (reservadoPorBinComEstoque[chaveBinConsultado] !== undefined) {
      const somaQtdeAtivas = reservasAtivas.reduce((acc, obj) => acc + (Number(obj.Qtde) || 0), 0);
      if (somaQtdeAtivas !== reservadoPorBinComEstoque[chaveBinConsultado]) {
        avisos.push(
          `BIN ${chaveBinConsultado} - soma das reservas ativas (${somaQtdeAtivas}) difere do Reservado no Estoque (${reservadoPorBinComEstoque[chaveBinConsultado]}).`
        );
      }
    }

    const linhasDoBin = reservasAtivas.map((obj) => {
      obj.Almoxarifado = almoxarifadoPorBin[chaveBinConsultado];
      return colunas.map((col) => (obj[col] !== undefined ? obj[col] : ''));
    });

    if (linhasDoBin.length) {
      mapaLinhasPorBin[chaveBinConsultado] = linhasDoBin;
    } else {
      delete mapaLinhasPorBin[chaveBinConsultado];
    }
    estadoConferidoPorBin[chaveBinConsultado] = reservadoPorBinComEstoque[chaveBinConsultado];
  });

  return { reservasEncontradas, binsSemReservaAtiva, avisos };
}

module.exports = {
  COLUNAS_RESERVAS,
  construirMapasEstoque,
  calcularBinsParaConsultar,
  podarBinsNaoReservados,
  aplicarResultadoLote,
};
