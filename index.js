'use strict';

/**
 * Ponto de entrada rodado pelo GitHub Actions (ver
 * .github/workflows/tempo-real.yml). Substitui o gatilho automático do
 * Apps Script (iniciarBuscaCompletaDeReservas / atualizarPedidosDasReservas)
 * - cada execução deste arquivo é uma "rodada" completa:
 *   Estoque -> Dashboard -> Reservas x Pedidos (delta) -> Dashboard de Separação
 *
 * Variáveis de ambiente esperadas (Secrets do repositório no GitHub):
 *   ORGM_TOKEN                  - TokenAcesso da ORGM
 *   ORGM_EMPRESA_ID             - EmpresaID da ORGM
 *   SPREADSHEET_ID              - ID da planilha (está na URL, entre /d/ e /edit)
 *   GOOGLE_SERVICE_ACCOUNT_JSON - conteúdo INTEIRO do arquivo JSON da conta
 *                                 de serviço do Google (a planilha precisa
 *                                 estar compartilhada com o e-mail dela)
 *
 * Nenhum desses valores deve ser colado direto no código - só em Secrets.
 */

const dns = require('dns');
// Força o Node a preferir IPv4 na resolução de DNS (não resolveu sozinho,
// mas não faz mal manter - ver comentário do Agent abaixo pra explicação
// atualizada do que realmente está acontecendo).
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Aumenta o tempo limite de CONEXÃO (não de resposta) usado pelo fetch
// nativo do Node em todo o processo. Motivo: o log mostrou
// "UND_ERR_CONNECT_TIMEOUT" nas 3 tentativas, sempre na mesma etapa (a
// primeira chamada de rede da execução, ainda "fria") - ou seja, não é
// intermitência nem bloqueio, é o servidor da ORGM (ou o caminho de rede até
// ele) simplesmente demorando mais pra aceitar essa primeira conexão do que
// o limite padrão do Node (10s). O undici (motor por trás do fetch nativo)
// permite configurar esse limite via um Agent global - aqui ele sobe pra 45s,
// dando bastante folga sem arriscar travar demais em caso de falha real.
const { Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 45_000 },
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  })
);

const { SheetsClient } = require('./src/sheetsClient');
const { executarRodadaPedidosDasReservas } = require('./src/reservas');

async function main() {
  const inicio = Date.now();
  const sheetsClient = new SheetsClient({});
  const resultado = await executarRodadaPedidosDasReservas(sheetsClient);
  const duracaoSeg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`Rodada concluída em ${duracaoSeg}s.`, JSON.stringify(resultado));
}

main().catch((e) => {
  console.error('Falha não tratada na rodada:', e);
  process.exitCode = 1;
});
