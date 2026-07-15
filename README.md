# ORGM - Atualização em Tempo Real (via GitHub Actions)

Esse projeto substitui o motor de automação que antes rodava dentro do
Google Apps Script (`EstoqueTempoReal.gs`) por um script Node.js rodando
no GitHub Actions. **A planilha do Google Sheets continua sendo exatamente
a mesma de sempre** - mesmas abas (Estoque, Reservas x Pedidos, Dashboard,
Dashboard Separação), mesma forma de abrir e consultar. Só muda onde o
"motor" que fala com a ORGM e atualiza a planilha está rodando.

A cada execução (a cada 5 minutos, por padrão), o script faz o mesmo ciclo
de sempre: Estoque -> Dashboard -> Reservas x Pedidos (só o que mudou) ->
Dashboard de Separação.

## Antes de começar: o que fica público

Você escolheu deixar este repositório **público** no GitHub, porque assim
os minutos do GitHub Actions são de graça e ilimitados (em repositório
privado, o plano gratuito só dá 2.000 minutos/mês, e rodando a cada 5
minutos isso estouraria bem rápido, virando um custo real todo mês).

Com o repositório público:
- **Nenhuma credencial fica exposta** - `ORGM_TOKEN`, `ORGM_EMPRESA_ID`,
  a chave da conta de serviço do Google e o ID da planilha ficam todos nos
  **Secrets** do repositório (criptografados, nunca aparecem no código nem
  nos logs).
- **O código da integração fica visível** pra qualquer pessoa - a lógica de
  negócio, os endpoints da ORGM e os IDs fixos usados nas chamadas
  (`PERGUNTA_ID_EXPORT`, `NOTA_ID`, `WRK_ID`, `DASH_ID`/`SERIE_ID` da busca
  de reservas). Nenhum desses é uma senha, mas são detalhes internos da
  integração.
- **Os logs de cada execução também ficam públicos** (aba "Actions" do
  repositório). Por isso o código foi escrito de propósito pra nunca
  logar número de BIN nem quantidade específica - só contagens agregadas
  (ex.: "3 BIN(s) com discrepância"). O detalhe completo de cada reserva
  continua só na própria planilha, que não é pública.

Se um dia preferir trocar pra privado (aceitando o custo ou reduzindo a
frequência), é só mudar a visibilidade do repositório nas configurações do
GitHub e ajustar o `cron` em `.github/workflows/tempo-real.yml` - nenhuma
mudança de código é necessária.

## Passo 1 - Google Cloud: conta de serviço (gratuito, sem cartão de crédito)

Isso é diferente do Cloud Functions que descartamos antes - aqui só
precisamos de uma "identidade robô" pra acessar a planilha por API, o que
não exige ativar faturamento.

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/) com
   a mesma conta Google da planilha.
2. Crie um projeto novo (qualquer nome, ex. "orgm-integracao").
3. No menu, vá em **APIs e Serviços > Biblioteca**, procure por
   **Google Sheets API** e clique em **Ativar**.
4. Vá em **APIs e Serviços > Credenciais > Criar Credenciais > Conta de
   Serviço**. Dê um nome (ex. "orgm-sheets-bot") e clique em Concluir (não
   precisa atribuir nenhum papel/role de projeto).
5. Clique na conta de serviço recém-criada > aba **Chaves** > **Adicionar
   Chave > Criar nova chave > JSON**. Isso baixa um arquivo `.json` -
   **guarde esse arquivo com cuidado, ele não pode ser commitado em lugar
   nenhum**.
6. Abra o arquivo baixado e copie o valor do campo `"client_email"` (algo
   como `orgm-sheets-bot@seu-projeto.iam.gserviceaccount.com`).
7. Abra sua planilha do Google Sheets, clique em **Compartilhar** e adicione
   esse e-mail como **Editor** - exatamente como se estivesse compartilhando
   com uma pessoa.
8. Pegue o **ID da planilha**: é o trecho da URL entre `/d/` e `/edit`,
   por exemplo em
   `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlmNoPQRstuVwxyz/edit`
   o ID é `1AbCdEfGhIjKlmNoPQRstuVwxyz`.

## Passo 2 - GitHub: criar o repositório e subir o código

1. Crie uma conta no [github.com](https://github.com) se ainda não tiver.
2. Clique em **New repository**. Escolha um nome (ex. `orgm-tempo-real`) e
   marque **Public**.
3. Suba os arquivos desta pasta pro repositório. O jeito mais simples sem
   usar terminal: na página do repositório recém-criado, clique em
   **uploading an existing file** e arraste todos os arquivos/pastas
   (mantendo a estrutura, incluindo a pasta `.github/workflows` e o arquivo
   `.gitignore`). Se preferir usar terminal com `git` instalado:
   ```
   cd caminho/para/esta/pasta
   git init
   git add .
   git commit -m "Primeira versão da integração ORGM"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/orgm-tempo-real.git
   git push -u origin main
   ```

## Passo 3 - Cadastrar os Secrets

No repositório, vá em **Settings > Secrets and variables > Actions > New
repository secret** e cadastre, um de cada vez:

| Nome do Secret | Valor |
|---|---|
| `ORGM_TOKEN` | o mesmo `TokenAcesso` que estava nas Propriedades do Script |
| `ORGM_EMPRESA_ID` | o mesmo `EmpresaID` que estava nas Propriedades do Script |
| `SPREADSHEET_ID` | o ID da planilha (Passo 1.8) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | o conteúdo **inteiro** do arquivo `.json` baixado no Passo 1.5 (abra o arquivo num editor de texto, copie tudo, cole aqui) |

## Passo 4 - Testar manualmente antes de confiar no automático

1. Vá na aba **Actions** do repositório. Se aparecer um aviso pra habilitar
   workflows, clique em habilitar.
2. Clique no workflow **"ORGM - Atualização em Tempo Real"** na lista à
   esquerda, depois no botão **Run workflow** (canto direito) > **Run
   workflow** de novo pra confirmar.
3. Acompanhe a execução clicando nela - se der erro, os logs (públicos,
   mas sem quantidade/BIN específicos) mostram o motivo. Erros comuns:
   Secret com nome ou valor errado, planilha não compartilhada com o
   e-mail da conta de serviço, ou `ORGM_TOKEN` expirado.
4. Se terminar sem erro, confira a planilha - as abas devem estar
   atualizadas igual antes.

## Passo 5 - Desligar o gatilho automático antigo do Apps Script

Importante: com o GitHub Actions rodando sozinho, o gatilho automático do
Apps Script não deve continuar ativo ao mesmo tempo (dois sistemas
escrevendo na mesma planilha ao mesmo tempo pode causar conflito). Na
planilha, vá no menu **ORGM > Parar Atualização em Tempo Real**. Os botões
manuais do menu (Atualizar Estoque, Criar/Atualizar Dashboard, etc.) podem
continuar existindo sem problema, já que não rodam sozinhos.

## Ajustando o intervalo

O intervalo está em `.github/workflows/tempo-real.yml`, na linha `cron:
'*/5 * * * *'` (a cada 5 minutos - o mínimo que o GitHub permite). Formato
padrão de cron (minuto hora dia mês dia-da-semana); por exemplo `*/10 * * *
*` roda a cada 10 minutos. O GitHub não garante o minuto exato (pode
atrasar um pouco em horários de pico da infraestrutura deles).

## Rodando os testes localmente

As partes de lógica pura (cálculo de delta, atribuição de Almoxarifado,
filtragem de reservas Baixado) têm testes que não precisam de nenhuma
credencial nem conexão de rede - incluindo casos específicos dos dois bugs
já corrigidos no histórico (BIN partido entre Almoxarifados, quantidade
"pela metade"):

```
npm install
npm test
```

## Estrutura do projeto

```
index.js                    - ponto de entrada (chamado pelo GitHub Actions)
src/orgmClient.js           - chamadas HTTP à ORGM
src/sheetsClient.js         - wrapper da API do Google Sheets
src/estoque.js              - export/leitura do Estoque (xlsx)
src/estadoReservas.js       - estado do delta (aba oculta _ORGM_EstadoReservas)
src/reservasLogica.js       - lógica pura do delta/upsert (testável)
src/reservas.js             - orquestra a rodada de Reservas x Pedidos
src/dashboard.js            - Dashboard de Estoque
src/dashboardSeparacao.js   - Dashboard de Separação
src/util.js                 - funções puras auxiliares
test/run-all.js             - testes de lógica pura
.github/workflows/tempo-real.yml - agendamento do GitHub Actions
```
