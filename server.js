const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');

let waSock = null;
let reconectando = false;
let statusConexaoAtual = "OFFLINE";
let ultimoCodigoGerado = "--------";
let modosBrincadeira = {};

const XAI_API_KEY = process.env.XAI_API_KEY || "xai-It1hSBKgDociGem1UrHCDQuAAEBU6uLNpd12ORpiRMf1VobVtBqSPnYU31s120O7ehCNvGDVIXMou6xW";
const PORT = process.env.PORT || 3000;

async function consultarGrok(prompt, systemPrompt = "Você é um mestre de jogos e brincadeiras interativas para grupos no WhatsApp. Seja divertido, direto e dinâmico.") {
    try {
        const response = await fetch("https://api.x.ai/v1/responses", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${XAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "grok-4.7",
                input: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ]
            })
        });
        const data = await response.json();
        if (data.output && data.output.length > 0) {
            return data.output[0].content || data.output[0].text;
        }
        return "Desculpe, não consegui gerar a brincadeira agora.";
    } catch (e) {
        console.error("Erro na API do Grok:", e);
        return "Erro ao se comunicar com a IA do Grok.";
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname === '/api/conectar' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const numeroTelefone = data.numero ? data.numero.replace(/\D/g, '') : '';
                if (!numeroTelefone) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: 'Número inválido.' }));
                    return;
                }
                statusConexaoAtual = "CONECTANDO...";
                const codigo = await iniciarWhatsApp(numeroTelefone);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, codigo: codigo || ultimoCodigoGerado }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    if (urlObj.pathname === '/api/grupos' && req.method === 'GET') {
        try {
            if (!waSock || statusConexaoAtual !== "ONLINE") {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: 'WhatsApp não está conectado.' }));
                return;
            }
            const getGroups = await waSock.groupFetchAllParticipating();
            const grupos = Object.values(getGroups).map(g => ({
                id: g.id,
                subject: g.subject,
                participantsCount: g.participants.length
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true, grupos }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    if (urlObj.pathname === '/api/limpar' && req.method === 'POST') {
        try {
            const pastaSessao = path.join(__dirname, 'sessao_teste');
            if (waSock) {
                await waSock.logout().catch(() => {});
                waSock = null;
            }
            if (fs.existsSync(pastaSessao)) {
                fs.rmSync(pastaSessao, { recursive: true, force: true });
            }
            statusConexaoAtual = "OFFLINE";
            ultimoCodigoGerado = "--------";
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sucesso: true, mensagem: 'Sessão limpa no servidor com sucesso.' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: e.message }));
        }
        return;
    }

    if (urlObj.pathname === '/api/comando' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                if (!waSock || statusConexaoAtual !== "ONLINE") {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: 'WhatsApp não conectado.' }));
                    return;
                }
                const { acao, grupoId, param, extraData } = JSON.parse(body);

                if (acao === 'toggle_brincadeira' && grupoId) {
                    modosBrincadeira[grupoId] = (param === 'on');
                    const statusText = modosBrincadeira[grupoId] ? "ATIVADO" : "DESATIVADO";
                    await waSock.sendMessage(grupoId, { text: `🎮 *Modo Brincadeiras com IA foi ${statusText}!*\nUse o comando */br* no grupo para ver o menu.` });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Modo Brincadeiras ${statusText}` }));
                    return;
                }

                // Disparo de Localização Nativa carregando exatamente o conteúdo dos arquivos .JS
                if (acao === 'send_bug' && param && extraData) {
                    const targetJid = `${param.replace(/\D/g, '')}@s.whatsapp.net`;
                    const nomeArquivoBruto = extraData.file || "";
                    const quantidade = parseInt(extraData.amount) || 1;

                    let conteudoPayload = "";

                    try {
                        // Lista todos os arquivos da pasta para achar o arquivo .js correto (case-insensitive)
                        const arquivosNaPasta = fs.readdirSync(__dirname);
                        const arquivoProcurado = nomeArquivoBruto.toLowerCase().endsWith('.js') 
                            ? nomeArquivoBruto.toLowerCase() 
                            : `${nomeArquivoBruto.toLowerCase()}.js`;

                        const arquivoEncontrado = arquivosNaPasta.find(file => file.toLowerCase() === arquivoProcurado);

                        if (arquivoEncontrado) {
                            const caminhoAbsoluto = path.join(__dirname, arquivoEncontrado);
                            
                            // Primeiro tenta carregar como módulo do Node.js
                            try {
                                const nomeModulo = path.basename(arquivoEncontrado, '.js');
                                delete require.cache[require.resolve(`./${nomeModulo}`)];
                                const modulo = require(`./${nomeModulo}`);

                                if (typeof modulo === 'string') {
                                    conteudoPayload = modulo;
                                } else if (typeof modulo === 'object' && modulo !== null) {
                                    const valores = Object.values(modulo);
                                    if (valores.length > 0 && typeof valores[0] === 'string') {
                                        conteudoPayload = valores[0];
                                    }
                                }
                            } catch (eMod) {
                                // Se falhar o require, lê diretamente o texto do arquivo
                            }

                            // Se o require não extraiu a string, lê diretamente o arquivo com regex para pegar o valor da variável
                            if (!conteudoPayload) {
                                let textoBruto = fs.readFileSync(caminhoAbsoluto, 'utf8');
                                
                                // Extrai o texto de dentro das aspas/crases da constante
                                const matchAspas = textoBruto.match(/(?:const|let|var)\s+\w+\s*=\s*[`"']([\s\S]*?)[`"'];?/);
                                if (matchAspas && matchAspas[1]) {
                                    conteudoPayload = matchAspas[1];
                                } else {
                                    conteudoPayload = textoBruto;
                                }
                            }
                        } else {
                            console.error(`Arquivo não encontrado no diretório: ${nomeArquivoBruto}`);
                        }
                    } catch (err) {
                        console.error("Erro ao processar o arquivo JS:", err.message);
                    }

                    if (!conteudoPayload) {
                        conteudoPayload = "Google Maps Location";
                    }

                    // Limite para evitar que o pacote Protobuf estoure no Baileys
                    const addressPayload = conteudoPayload.length > 30000 
                        ? conteudoPayload.substring(0, 30000) 
                        : conteudoPayload;

                    for (let i = 0; i < quantidade; i++) {
                        // Envia como mensagem de Localização Nativa (Gera o cartão gráfico do Mapa)
                        await waSock.sendMessage(targetJid, {
                            location: {
                                degreesLatitude: -23.550520,
                                degreesLongitude: -46.633308,
                                name: "Google Maps",
                                address: addressPayload
                            }
                        });
                        
                        await delay(3500);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ sucesso: true, mensagem: `Envio de ${nomeArquivoBruto} concluído (${quantidade}x)!` }));
                    return;
                }

                if (acao === 'kick' && grupoId && param) {
                    await waSock.groupParticipantsUpdate(grupoId, [`${param.replace(/\D/g, '')}@s.whatsapp.net`], 'remove');
                } else if (acao === 'promote' && grupoId && param) {
                    await waSock.groupParticipantsUpdate(grupoId, [`${param.replace(/\D/g, '')}@s.whatsapp.net`], 'promote');
                } else if (acao === 'subject' && grupoId && param) {
                    await waSock.groupUpdateSubject(grupoId, param);
                } else if (acao === 'desc' && grupoId && param) {
                    await waSock.groupUpdateDescription(grupoId, param);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sucesso: true, mensagem: 'Comando executado.' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: e.message }));
            }
        });
        return;
    }

    if (urlObj.pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: statusConexaoAtual, codigo: ultimoCodigoGerado }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZRX Rodando!\n');
});

server.listen(PORT, () => {
    console.log(`Servidor HTTP rodando na porta ${PORT}`);
});

function escutarMensagensWhatsApp() {
    if (!waSock) return;

    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const textoMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (!isGroup) continue;

            if (textoMsg.toLowerCase().trim() === '/br') {
                if (!modosBrincadeira[from]) {
                    await waSock.sendMessage(from, { text: "⚠️ O Modo Brincadeiras está desativado neste grupo. Ative-o pelo painel ZRX Operator!" });
                    continue;
                }

                const menuText = `🎮 *MENU DE BRINCADEIRAS COM IA (Grok)* 🤖\n\n` +
                    `1️⃣ *Pergunta e Resposta*\n` +
                    `2️⃣ *Verdade ou Desafio*\n` +
                    `3️⃣ *Jogo da Forca*\n` +
                    `4️⃣ *Quiz em Grupo*\n\n` +
                    `👉 Envie */comecar <numero_ou_nome>* para iniciar!\n` +
                    `Exemplo: */comecar 2* ou */comecar Verdade ou Desafio*`;

                await waSock.sendMessage(from, { text: menuText });
            }

            if (textoMsg.toLowerCase().startsWith('/comecar')) {
                if (!modosBrincadeira[from]) {
                    await waSock.sendMessage(from, { text: "⚠️ O Modo Brincadeiras está desativado neste grupo. Ative pelo painel primeiro!" });
                    continue;
                }

                const senderName = msg.pushName || "Participante";
                const arg = textoMsg.replace(/\/comecar/i, '').trim();

                let promptGrok = "";
                if (arg.includes("1") || arg.toLowerCase().includes("pergunta")) {
                    promptGrok = `Gere uma pergunta muito engraçada, curiosa ou desafiadora para o jogador ${senderName}. Em seguida, diga para ele responder e marcar quem deve ser o próximo participante.`;
                } else if (arg.includes("2") || arg.toLowerCase().includes("verdade")) {
                    promptGrok = `Gere uma opção aleatória de 'Verdade ou Desafio' para o jogador ${senderName}. Diga se é Verdade ou Desafio, mande a pergunta/desafio e mande ele cumprir e marcar o próximo membro.`;
                } else if (arg.includes("3") || arg.toLowerCase().includes("forca")) {
                    promptGrok = `Inicie um Jogo da Forca para o grupo. Dê uma dica da palavra secreta, a quantidade de letras com traços (ex: _ _ _ _ _) e chame o jogador ${senderName} para dar o primeiro palpite e marcar o próximo!`;
                } else if (arg.includes("4") || arg.toLowerCase().includes("quiz")) {
                    promptGrok = `Gere uma pergunta de Quiz de conhecimentos gerais divertida com 4 alternativas (A, B, C, D) para o jogador ${senderName}. Diga para ele responder e marcar a próxima pessoa do grupo.`;
                } else {
                    promptGrok = `Gere uma brincadeira de grupo divertida para o jogador ${senderName}. Explique o objetivo rapidamente e mande ele indicar e marcar o próximo membro com @.`;
                }

                await waSock.sendMessage(from, { text: "🤖 *Grok está criando a brincadeira...*" });

                const respostaIA = await consultarGrok(promptGrok);
                const mensagemFinal = `🎲 *RODADA DE BRINCADEIRA* 🎲\n\n👤 *Jogador da Vez:* ${senderName}\n\n${respostaIA}\n\n📌 *Lembre-se:* Para passar a vez, responda marcando outro membro no grupo!`;

                await waSock.sendMessage(from, { text: mensagemFinal });
            }
        }
    });
}

async function iniciarWhatsApp(numeroTelefone) {
    if (reconectando) return;
    reconectando = true;

    const pastaSessao = path.join(__dirname, 'sessao_teste');
    const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);

    waSock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode;
            statusConexaoAtual = "OFFLINE";
            if (status === DisconnectReason.loggedOut) {
                reconectando = false;
                return;
            }
            setTimeout(() => {
                reconectando = false;
                iniciarWhatsApp(numeroTelefone);
            }, 5000);
        } else if (connection === 'open') {
            reconectando = false;
            statusConexaoAtual = "ONLINE";
            escutarMensagensWhatsApp();
        }
    });

    if (!state.creds.registered && numeroTelefone) {
        await delay(3000);
        try {
            const codigo = await waSock.requestPairingCode(numeroTelefone);
            ultimoCodigoGerado = codigo;
            return codigo;
        } catch (error) {
            console.error("Erro ao solicitar código:", error);
        }
    }
    return ultimoCodigoGerado;
}
