# DR Darre – Sistema de vendas

Sistema de vendas e estoque para loja de roupas. Funciona no navegador, sem instalação e sem servidor próprio.
Os dados ficam no aparelho e, se você conectar, também no seu projeto Supabase.

## Estrutura

```
dr-darre-app/
├── index.html                 telas do sistema
├── css/estilo.css             visual (cores, tema claro/escuro, impressão)
├── js/app.js                  lógica: vendas, estoque, relatórios, sincronização
├── sql/drdarre-supabase.sql   script que cria as tabelas na nuvem
├── manifest.webmanifest       nome, ícone e cores do aplicativo
├── sw.js                      faz o aplicativo abrir sem internet
├── icons/                     ícones do aplicativo
├── fonts/                     fontes embutidas (não depende do Google)
├── vendor/qrcode.min.js       gerador de QR code embutido
└── .vscode/                   configurações e extensões recomendadas
```

## Rodar no VS Code

1. Descompacte o zip e abra a pasta `dr-darre-app` no VS Code (Arquivo › Abrir Pasta).
2. Instale a extensão recomendada **Live Server** (o VS Code sugere ao abrir a pasta).
3. Clique com o botão direito em `index.html` › **Open with Live Server**.
4. O sistema abre em `http://127.0.0.1:5500` e recarrega sozinho a cada arquivo salvo.

Os dados de teste ficam no navegador para o endereço `127.0.0.1:5500`. Ao publicar em outro endereço eles não vão junto:
use **Ajustes › Baixar backup** e **Restaurar backup**, ou conecte a nuvem.

## Onde mexer

| Quero mudar | Arquivo | Onde |
|---|---|---|
| Cores e fontes | `css/estilo.css` | variáveis no início (`--gold`, `--ink`, `--bg`) e bloco do tema escuro |
| Tipos de peça e tamanhos padrão | `js/app.js` | constante `DEF_CFG` (também muda pelo sistema, em Ajustes) |
| Texto do comprovante no WhatsApp | `js/app.js` | função `textoWa` |
| Layout do recibo | `js/app.js` | função `reciboHTML` |
| Tamanho e layout das etiquetas | `css/estilo.css` | bloco "etiquetas", classes `.etq`, `.et-bar` |
| Código de barras das etiquetas | `js/app.js` | função `barrasSVG` (Code 128, lido por leitor USB/Bluetooth e pela câmera) |
| Nomes das vendedoras | pelo sistema | Ajustes › Tipos, tamanhos e vendedoras (a opção Outros aparece sempre) |
| Aba Estoque, consulta e devoluções | `js/app.js` | bloco `ESTOQUE`: `rConsulta`, `abrirDevolucao`, `movimentos`, `rEstoque` |
| Sincronização com a nuvem | `js/app.js` | objeto `Cloud` e funções `sync`, `enviar`, `receber` |
| Tabelas e regras de estoque no banco | `sql/drdarre-supabase.sql` | |

Se mudar colunas das tabelas, atualize também o objeto `PICK` em `js/app.js`, que define o que é enviado à nuvem.

## Novidades da versão 3.3

- **Aba Estoque:** entradas, vendas, devoluções e ajustes por período, estoque atual por tipo e planilha das movimentações.
- **Consulta de peça:** digite o código ou leia o código de barras (também pelo ícone no topo ou F3). Mostra preço e estoque; se a peça foi vendida, mostra quando, para quem, por qual vendedora e o valor pago.
- **Etiquetas com código de barras** e o código escrito embaixo. O QR code continua como opção.
- **Devolução:** em Editar peça ou na consulta, a peça volta ao estoque ligada à venda de origem.
- **Vendedora em cada venda:** Regina, Bianca ou Outros (com nome). Aparece no recibo, no relatório e na planilha.

Quem já usa a nuvem precisa rodar de novo o `sql/drdarre-supabase.sql` no SQL Editor (ele só acrescenta colunas, não apaga nada).
Até rodar, as vendas continuam guardadas no aparelho e sobem assim que o banco for atualizado.

## Nuvem (opcional)

1. Crie um projeto em supabase.com (região São Paulo).
2. Rode `sql/drdarre-supabase.sql` no SQL Editor.
3. Crie o usuário da loja em Authentication › Users (marque Auto Confirm User) e desligue novos cadastros em Sign In / Providers.
4. No sistema, em **Ajustes › Nuvem**, informe o endereço do projeto, a chave pública, o e-mail e a senha.

A baixa de estoque é feita por gatilhos no banco, então vários aparelhos podem vender ao mesmo tempo, inclusive offline.

## Publicar e instalar como aplicativo

Para virar aplicativo no celular, o sistema precisa estar num endereço **https**. O GitHub Pages é gratuito:

1. Crie uma conta em github.com e um repositório novo (pode ser privado só se tiver plano pago; público é grátis).
2. No VS Code, em Controle do Código-Fonte, clique em **Publicar no GitHub** e escolha esse repositório.
3. No GitHub, abra o repositório › **Settings › Pages** › em Branch escolha `main` e a pasta `/ (root)` › **Save**.
4. Em um ou dois minutos o endereço aparece, algo como `https://seu-usuario.github.io/dr-darre-app/`.

Para instalar:

- **Android (Chrome):** abra o endereço, depois menu ⋮ › **Instalar aplicativo**. O próprio sistema também mostra o botão em Início e em Ajustes.
- **iPhone (Safari):** abra o endereço › botão Compartilhar › **Adicionar à Tela de Início**.
- **Computador (Chrome ou Edge):** ícone de instalar na barra de endereço.

O aplicativo abre em tela cheia e funciona sem internet. A câmera para ler etiquetas só funciona em https.

### Publicar uma versão nova

Depois de alterar qualquer arquivo, abra `sw.js` e aumente o número em `VERSAO` (por exemplo `prdarre-3.2.0` → `prdarre-3.2.1`).
Se você acrescentar arquivos novos, inclua o caminho deles na lista `ARQUIVOS`.
Ao abrir o aplicativo, aparece o aviso "Há uma versão nova do sistema" com o botão Atualizar.

> Com o Live Server, o `sw.js` também funciona (em `127.0.0.1`). Se uma mudança não aparecer durante os testes,
> aumente a VERSAO ou, no navegador, F12 › Application › Service workers › marque **Update on reload**.
