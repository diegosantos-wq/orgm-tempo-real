'use strict';

/**
 * Cliente HTTP da ORGM - porte direto da parte de rede de EstoqueTempoReal.gs
 * (chamarORGM_, dispararExportEstoque_, anexoMaisRecente_, baixarAnexo_,
 * buscarReservasDeVariosBins_), trocando UrlFetchApp pelo fetch nativo do
 * Node (>=20) e Promise.all no lugar de UrlFetchApp.fetchAll.
 *
 * Nenhum valor de credencial fica neste arquivo - tudo vem de variáveis de
 * ambiente (Secrets do GitHub Actions), igual ORGM_TOKEN/ORGM_EMPRESA_ID
 * viviam em Propriedades do Script no Apps Script. NUNCA cole esses valores
 * direto no código.
 */

const { temValorPreenchido, extrairDataDotNet, sleep } = require('./util');

const ENDPOINT_URL = 'https://ws4.workorgm.com/ICC/OrgmSiteWebservice.asmx/EndPointGet';
const DOWNLOAD_URL = 'https://ws4.workorgm.com/ICC/OrgmSiteWebservice.asmx/DownloadAnexo';

// Identificadores fixos do botão "Exportar Estoque Excel" nesse WORK (142131).
const PERGUNTA_ID_EXPORT = 3226379;
const NOTA_ID = 543551;
const WRK_ID = 142131;

// DashID/SerieID da busca "Bin Historico" (Reservas por BIN).
const DASH_ID_BIN_HISTORICO = 68;
const SERIE_ID_BIN_HISTORICO = 1792;

function credenciais() {
  const token = process.env.ORGM_TOKEN;
  const empresaId = process.env.ORGM_EMPRESA_ID;
  if (!token || !empresaId) {
    throw new Error('Configure ORGM_TOKEN e ORGM_EMPRESA_ID nos Secrets do GitHub Actions antes de usar.');
  }
  return {
    TokenAcesso: token,
    EmpresaID: empresaId,
    Language: 'ptbr',
  };
}

function formEncode(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

// Quantas vezes tenta cada chamada antes de desistir, e quanto espera entre
// tentativas. Existe porque descobrimos (via o "causa: UND_ERR_CONNECT_TIMEOUT"
// no log) que a conexão com a ORGM às vezes trava só na etapa de exportar o
// Estoque, mesmo com o mesmo token/empresa/endereço funcionando normalmente
// na busca de reservas - ou seja, não é falta de configuração, parece ser
// uma falha de rede intermitente (o GitHub Actions muda de IP a cada
// execução, então às vezes a rota até a ORGM funciona, às vezes não).
// Tentar de novo automaticamente cobre esse caso sem precisar de ação manual.
const TENTATIVAS_FETCH = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 3000;

/**
 * Wrapper em volta do fetch nativo que (1) tenta de novo em caso de falha de
 * rede (ver TENTATIVAS_FETCH acima) e (2) anexa a causa raiz (err.cause) na
 * mensagem de erro final. O fetch do Node (undici) joga um "TypeError: fetch
 * failed" genérico pra qualquer falha de rede - o motivo de verdade
 * (timeout, DNS, conexão recusada, certificado, IP bloqueado, etc.) fica só
 * em err.cause, que se perde se a gente só faz `'texto: ' + e` (que é
 * exatamente o que o log de "Falha ao atualizar o Estoque" faz). Isso é só
 * diagnóstico de rede/infraestrutura - nenhum dado de estoque/reserva -
 * então não tem problema aparecer no log de um repositório público.
 */
async function fetchComDiagnostico(url, options) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS_FETCH; tentativa++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      const causa = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : null;
      ultimoErro = new Error(
        (e && e.message ? e.message : String(e)) +
          (causa ? ' | causa: ' + causa : ' | (sem causa detalhada disponível)') +
          ` | tentativa ${tentativa}/${TENTATIVAS_FETCH}`
      );
      ultimoErro.original = e;
      if (tentativa < TENTATIVAS_FETCH) {
        await sleep(ESPERA_ENTRE_TENTATIVAS_MS);
      }
    }
  }
  throw ultimoErro;
}

/**
 * Chamador genérico do EndPointGet (Chamada + JsonChamada).
 */
async function chamarORGM(chamada, paramsExtras) {
  const corpo = Object.assign({}, credenciais(), paramsExtras || {});

  const resposta = await fetchComDiagnostico(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({
      Chamada: chamada,
      JsonChamada: JSON.stringify(corpo),
    }),
  });

  const texto = await resposta.text();
  if (resposta.status !== 200) {
    throw new Error('ORGM (' + chamada + ') respondeu ' + resposta.status + ': ' + texto);
  }
  return JSON.parse(texto);
}

function respostaExportPayload() {
  return {
    PerguntaID: PERGUNTA_ID_EXPORT,
    Respostas: [{ Id: null, OpcaoID: 1, Resposta: '', RespostaTexto: '', text: '' }],
    NotaID: NOTA_ID,
    WrkID: WRK_ID,
  };
}

/**
 * Equivalente a clicar em "Exportar Estoque Excel" - dispara a geração do
 * relatório no servidor (assíncrono, não devolve o arquivo direto).
 */
async function dispararExportEstoque() {
  await chamarORGM('WORK_ValidarResponderPergunta', respostaExportPayload());
  await chamarORGM('WORK_SalvarNotaRespostas', respostaExportPayload());
}

/**
 * Lista os anexos da Nota e devolve o mais recente (maior DtEnvio).
 */
async function anexoMaisRecente() {
  const lista = await chamarORGM('WORK_ListarAnexosNota', { NotaID: NOTA_ID, WrkID: WRK_ID });
  if (!lista || !lista.length) return null;
  lista.sort((a, b) => extrairDataDotNet(b.DtEnvio) - extrairDataDotNet(a.DtEnvio));
  return lista[0];
}

/**
 * Baixa o binário do xlsx a partir do TokenAnexo. Devolve um Buffer (em vez
 * do Blob do Apps Script) - a lib "xlsx" lê Buffer diretamente, sem precisar
 * do truque de converter num Google Sheets temporário via Drive API.
 */
async function baixarAnexo(tokenAnexo) {
  const corpoInterno = Object.assign(
    { TokenAnexo: tokenAnexo, NotaID: NOTA_ID, WrkID: WRK_ID },
    credenciais()
  );
  const corpoExterno = { Chamada: 'WORK_DownloadAnexoNota', JsonChamada: JSON.stringify(corpoInterno) };

  const resposta = await fetchComDiagnostico(DOWNLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({ data: JSON.stringify(corpoExterno) }),
  });

  if (resposta.status !== 200) {
    throw new Error('Download do anexo falhou: ' + resposta.status);
  }
  const arrayBuffer = await resposta.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * "Achata" uma linha de busca (array de {Campo, Valor}) num objeto simples,
 * e calcula TipoPedido/Pedido (OV ou OP, o que estiver preenchido).
 */
function achatarLinhaBusca(linha) {
  const obj = {};
  linha.forEach((campo) => {
    obj[campo.Campo] = campo.Valor;
  });
  if (temValorPreenchido(obj.OrdemVenda)) {
    obj.TipoPedido = 'OV';
    obj.Pedido = obj.OrdemVenda;
  } else if (temValorPreenchido(obj.OrdemProducao)) {
    obj.TipoPedido = 'OP';
    obj.Pedido = obj.OrdemProducao;
  } else {
    obj.TipoPedido = '';
    obj.Pedido = '';
  }
  return obj;
}

// Quantos BINs consultar de uma vez em paralelo (equivalente a
// UrlFetchApp.fetchAll), em vez de um de cada vez com pausa entre eles.
const TAMANHO_LOTE_BUSCA_RESERVAS = 25;

async function buscarReservasDeUmBin(bin) {
  const corpo = Object.assign(
    { PalavrasChave: [String(bin)], DashID: DASH_ID_BIN_HISTORICO, SerieID: SERIE_ID_BIN_HISTORICO },
    credenciais()
  );
  const resposta = await fetchComDiagnostico(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode({
      Chamada: 'MenuWEB_GetResultadoBusca',
      JsonChamada: JSON.stringify(corpo),
    }),
  });
  if (resposta.status !== 200) {
    const erro = new Error('HTTP ' + resposta.status);
    erro.httpStatus = resposta.status;
    throw erro;
  }
  const texto = await resposta.text();
  const corpoResp = JSON.parse(texto);
  const linhasResp = (corpoResp && corpoResp.Dados) || [];
  return linhasResp.map(achatarLinhaBusca);
}

/**
 * Versão em lote: dispara todas as consultas do lote em paralelo
 * (Promise.all), na mesma ordem de "bins" de entrada. Cada posição devolve
 * { ok, linhas }:
 *   - ok=true e linhas=[] => consulta funcionou, realmente não há reserva.
 *   - ok=false => consulta falhou (rede/HTTP/JSON); quem chama não deve
 *     apagar um resultado anterior só por causa disso.
 *
 * Se TODAS as consultas do lote falharem com o mesmo erro de cota/limite,
 * relança o erro pra quem chama decidir parar a rodada (mesmo
 * comportamento do catch em torno de UrlFetchApp.fetchAll no .gs
 * original, que detectava esgotamento de cota e parava a rodada).
 */
async function buscarReservasDeVariosBins(bins) {
  const resultados = await Promise.all(
    bins.map(async (bin) => {
      try {
        const linhas = await buscarReservasDeUmBin(bin);
        return { ok: true, linhas };
      } catch (e) {
        return { ok: false, linhas: [], erro: String((e && e.message) || e) };
      }
    })
  );

  // Se o lote inteiro falhou (todas as posições ok=false) e a mensagem
  // parece ser de limite/cota/rate-limit, propaga como erro de verdade pro
  // chamador poder parar a rodada - do contrário, um provedor fora do ar
  // por completo passaria despercebido como "confirmado sem reserva".
  const todasFalharam = resultados.length > 0 && resultados.every((r) => !r.ok);
  if (todasFalharam) {
    const primeiraFalha = resultados.find((r) => r.erro) || {};
    const erro = new Error(primeiraFalha.erro || 'Todas as consultas do lote falharam.');
    erro.loteInteiroFalhou = true;
    throw erro;
  }

  return resultados;
}

module.exports = {
  ENDPOINT_URL,
  DOWNLOAD_URL,
  TAMANHO_LOTE_BUSCA_RESERVAS,
  credenciais,
  chamarORGM,
  dispararExportEstoque,
  anexoMaisRecente,
  baixarAnexo,
  achatarLinhaBusca,
  buscarReservasDeVariosBins,
};
