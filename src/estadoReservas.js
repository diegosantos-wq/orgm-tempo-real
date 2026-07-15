'use strict';

/**
 * Porte de carregarEstadoConferidoPorBin_ / salvarEstadoConferidoPorBin_ do
 * .gs original: guarda, numa aba oculta "_ORGM_EstadoReservas", qual era o
 * Reservado (no Estoque) na última vez que cada BIN foi confirmado via
 * busca na ORGM. É esse estado que permite reconsultar só os BINs que
 * mudaram de uma rodada pra outra.
 */

const { colIndexToLetter } = require('./sheetsClient');

const NOME_ABA_ESTADO_RESERVAS = '_ORGM_EstadoReservas';

async function carregarEstadoConferidoPorBin(sheetsClient) {
  const existe = (await sheetsClient.getSheetMeta(NOME_ABA_ESTADO_RESERVAS)) !== null;
  const mapa = {};
  if (!existe) return mapa;
  const valores = await sheetsClient.getValues(NOME_ABA_ESTADO_RESERVAS);
  // pula o cabeçalho (linha 0)
  for (let i = 1; i < valores.length; i++) {
    const bin = valores[i][0];
    if (bin !== '' && bin !== null && bin !== undefined) {
      mapa[String(bin)] = Number(valores[i][1]) || 0;
    }
  }
  return mapa;
}

async function salvarEstadoConferidoPorBin(sheetsClient, mapa) {
  await sheetsClient.ensureSheet(NOME_ABA_ESTADO_RESERVAS, { hidden: true });
  await sheetsClient.clearValues(NOME_ABA_ESTADO_RESERVAS);
  const chaves = Object.keys(mapa).sort();
  const linhas = [['BIN', 'ReservadoConferido']].concat(chaves.map((bin) => [bin, mapa[bin]]));
  const ultimaColuna = colIndexToLetter(1);
  await sheetsClient.setValues(NOME_ABA_ESTADO_RESERVAS, `A1:${ultimaColuna}${linhas.length}`, linhas);
}

module.exports = { carregarEstadoConferidoPorBin, salvarEstadoConferidoPorBin, NOME_ABA_ESTADO_RESERVAS };
