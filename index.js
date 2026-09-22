const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const P = require('pino');

// Inicializa o Firebase Admin usando as variáveis de ambiente ou arquivo de configuração do Render
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

    // Fica escutando a coleção 'sessoes_pareamento' em tempo real (mesma do seu HTML)
    db.collection('sessoes_pareamento').onSnapshot(async (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const docId = change.doc.id; // Esse ID é o código de 8 dígitos gerado pelo painel HTML!
                const dados = change.doc.data();

                // Se o status estiver pendente e o bot ainda não estiver registrado/conectado
                if (dados.status === 'pendente' && !sock.authState.creds.registered) {
                    console.log(`Recebida solicitação de pareamento para o código: ${docId}`);
                    
                    // Aqui você define o número de telefone que vai receber o pareamento (ou pode puxar do banco)
                    // Exemplo: Coloque o número com DDI e DDD (ex: 5511999999999)
                    const numeroTelefone = dados.numero || "5511999999999"; 

                    try {
                        // Aguarda um momento para garantir que o socket está pronto
                        await new Promise(resolve => setTimeout(resolve, 3000));

                        // O Baileys solicita o código de 8 dígitos para o WhatsApp
                        const codigoPareamento = await sock.requestPairingCode(numeroTelefone);
                        console.log(`✨ Código de 8 dígitos do WhatsApp gerado: ${codigoPareamento}`);

                        // Atualiza o documento no Firebase para que o seu painel ou terminal saiba
                        await db.collection('sessoes_pareamento').doc(docId).update({
                            codigoBaileys: codigoPareamento,
                            status: 'gerado'
                        });
                    } catch (erro) {
                        console.error('Erro ao solicitar código de pareamento:', erro);
                    }
                }
            }
        });
    });
}

iniciarBot();
