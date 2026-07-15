'use strict';

/**
 * Funções puras (sem I/O) portadas de EstoqueTempoReal.gs. Mantidas isoladas
 * nesse arquivo de propósito, pra dar pra testar sem precisar de nenhuma
 * credencial nem chamada de rede (ver test/util.test.js).
 */

function temValorPreenchido(v) {
  return v !== null && v !== undefined && v !== '';
}

/**
 * Regra do Lote_Interno (ex.: "186364-L04005-19-323756"):
 *   - primeiro pedaço antes do 1º "-"  = número de OC/PC   ("186364")
 *   - último pedaço depois do último "-" = número da nota fiscal ("323756")
 */
function extrairOcPc(loteInterno) {
  if (!loteInterno) return '';
  return String(loteInterno).split('-')[0];
}

function extrairNotaFiscal(loteInterno) {
  if (!loteInterno) return '';
  const partes = String(loteInterno).split('-');
  return partes[partes.length - 1];
}

/**
 * Galpão = prefixo numérico do Local/posição (ex.: "03A01" -> galpão 3).
 */
function extrairGalpao(local) {
  if (!local) return '';
  const m = /^(\d+)/.exec(String(local));
  return m ? parseInt(m[1], 10) : '';
}

/**
 * Corrige um valor de "Local" que o Excel/Sheets reinterpretou como número em
 * notação científica (ex.: "07E07" virou 70000000). Ver comentário completo
 * no .gs original - a ideia é reconstruir "MM" + "E" + "EE" a partir dos
 * zeros finais do número.
 */
function corrigirLocalCorrompido(valor) {
  if (typeof valor !== 'number' || !isFinite(valor) || valor === 0) return valor;
  const str = String(Math.round(valor));
  const zeros = /0*$/.exec(str)[0];
  const expoente = zeros.length;
  if (expoente === 0) return valor;
  let mantissa = str.slice(0, str.length - expoente) || '0';
  if (mantissa.length < 2) mantissa = ('00' + mantissa).slice(-2);
  const expoenteTexto = expoente < 10 ? '0' + expoente : String(expoente);
  return mantissa + 'E' + expoenteTexto;
}

/**
 * Aplica corrigirLocalCorrompido na coluna "Local" de todas as linhas de
 * dados (pula o cabeçalho). Modifica "linhas" in place, igual ao original.
 */
function corrigirColunaLocal(linhas) {
  if (!linhas || !linhas.length) return;
  let colLocal = linhas[0].indexOf('Local');
  if (colLocal < 0) colLocal = 2;
  for (let i = 1; i < linhas.length; i++) {
    linhas[i][colLocal] = corrigirLocalCorrompido(linhas[i][colLocal]);
  }
}

// Converte "/Date(1783444559000-0300)/" (padrão .NET/ASMX) em timestamp (ms).
function extrairDataDotNet(dotNetDate) {
  const m = /\/Date\((\d+)/.exec(dotNetDate || '');
  return m ? parseInt(m[1], 10) : 0;
}

function localJaSeparado(local) {
  return /^Z/i.test(String(local || ''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  temValorPreenchido,
  extrairOcPc,
  extrairNotaFiscal,
  extrairGalpao,
  corrigirLocalCorrompido,
  corrigirColunaLocal,
  extrairDataDotNet,
  localJaSeparado,
  sleep,
};
