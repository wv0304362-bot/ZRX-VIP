const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const P = require('pino');

initializeApp();
const db = getFirestore();

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                iniciarBot();
            }
        } else if (connection === 'open') {
            console.log('🚀 WhatsApp conectado com sucesso na nuvem!');
        }
    });

    // Escuta a coleção de pareamento em tempo real
    db.collection('sessoes_pareamento').onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const docId = change.doc.id; 
                const dados = change.doc.data();

                // Se o status estiver pendente e tiver um número informado no painel
                if (dados && dados.status === 'pendente' && dados.numero) {
                    const numeroTelefone = dados.numero;
                    console.log(`📱 Solicitação recebida para o número: ${numeroTelefone} (Código: ${docId})`);

                    try {
                        // Aguarda o socket estabilizar
                        await new Promise(resolve => setTimeout(resolve, 3000));

                        // Solicita o código real de 8 dígitos ao WhatsApp via Baileys
                        const codigoPareamento = await sock.requestPairingCode(numeroTelefone);
                        console.log(`✨ Código de 8 dígitos gerado: ${codigoPareamento}`);

                        // Atualiza o documento com o código gerado para o painel exibir
                        await db.collection('sessoes_pareamento').doc(docId).update({
                            codigoBaileys: codigoPareamento,
                            status: 'gerado'
                        });

                    } catch (erro) {
                        console.error('Erro ao gerar o código de pareamento:', erro);
                        await db.collection('sessoes_pareamento').doc(docId).update({
                            status: 'erro'
                        });
                    }
                }
            }
        });
    });
}

iniciarBot();
