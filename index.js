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
