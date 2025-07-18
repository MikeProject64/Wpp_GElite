import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { Server, Socket as SocketIO } from 'socket.io';
import qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import logger from './logger';
import { isJidUser } from '@whiskeysockets/baileys';
import { db } from './firebaseAdmin';
import admin from 'firebase-admin';

const sessions = new Map<string, WASocket>();
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

async function createWhatsAppSocket(sessionId: string, socketIO: SocketIO): Promise<WASocket> {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const sessionLogger = logger.child({ sessionId });

        if (qr) {
            sessionLogger.info('QR Code recebido, enviando para o cliente...');
            const qrCodeUrl = await qrcode.toDataURL(qr);
            socketIO.emit('qr', qrCodeUrl);
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            
            // Não reconectar se:
            // 1. O usuário fez logout.
            // 2. A conexão foi substituída por outra sessão.
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionReplaced;

            sessionLogger.warn({ reason: lastDisconnect?.error, statusCode }, `Conexão fechada. Reconectando: ${shouldReconnect}`);
            
            sessions.delete(sessionId);

            if (shouldReconnect) {
                sessionLogger.info('Tentando reconectar...');
                createWhatsAppSocket(sessionId, socketIO); // Tenta recriar o socket
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                sessionLogger.warn('Conexão substituída por outra sessão.');
                socketIO.emit('replaced', 'Sua sessão foi conectada em outro local.');
            } else {
                sessionLogger.info('Desconexão permanente. Limpando sessão do disco.');
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                socketIO.emit('disconnected', 'Você foi desconectado permanentemente.');
            }
        } else if (connection === 'open') {
            sessionLogger.info('Conexão com o WhatsApp estabelecida!');
            sessions.set(sessionId, sock);
            socketIO.emit('connected', 'Conectado com sucesso ao WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const sessionLogger = logger.child({ sessionId });
        const m = messages[0];

        if (!m.message || m.key.fromMe || !isJidUser(m.key.remoteJid!)) {
            return;
        }

        sessionLogger.info({ msg: m }, 'Nova mensagem recebida.');

        const contactId = m.key.remoteJid!;
        const messageContent = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const messageTimestamp = new Date(Number(m.messageTimestamp) * 1000);

        try {
            const chatRef = db.collection('users').doc(sessionId).collection('whatsapp_chats').doc(contactId);
            const messageRef = chatRef.collection('messages');

            // Salva a mensagem
            await messageRef.add({
                fromMe: false,
                text: messageContent,
                timestamp: messageTimestamp,
                // Lógica para mídia virá depois
            });

            // Atualiza as informações do chat
            await chatRef.set({
                name: m.pushName || contactId.split('@')[0], // Usa o nome do contato ou o ID formatado
                unreadCount: admin.firestore.FieldValue.increment(1),
                lastMessage: messageContent,
                lastMessageTimestamp: messageTimestamp,
            }, { merge: true });

            sessionLogger.info({ contactId }, 'Mensagem salva no Firestore.');

            // Envia a mensagem para o frontend
            socketIO.emit('new_message', {
                contactId: contactId,
                message: {
                    fromMe: false,
                    text: messageContent,
                    timestamp: messageTimestamp.toISOString(),
                }
            });

        } catch (error) {
            sessionLogger.error({ error, contactId }, "Erro ao salvar mensagem no Firestore.");
        }
    });

    return sock;
}

// Mapeia o UID do usuário para sua conexão de socket.io
const userSocketMap = new Map<string, SocketIO>();

export function initWhatsApp(socketIO: SocketIO, io: Server, userId: string) {
    logger.info({ userId, socketId: socketIO.id }, 'Iniciando gerenciamento de sessão de WhatsApp.');
    
    userSocketMap.set(userId, socketIO);

    createWhatsAppSocket(userId, socketIO);

    socketIO.on('check_number', async ({ phoneNumber }: { phoneNumber: string }) => {
        const sock = sessions.get(userId);
        const sessionLogger = logger.child({ sessionId: userId });
        sessionLogger.info({ phoneNumber }, 'Verificando número de telefone.');

        if (sock) {
            try {
                // Remove caracteres não numéricos. Ex: (11) 99999-8888 -> 11999998888
                const formattedNumber = phoneNumber.replace(/\D/g, '');
                const onWhatsAppResult = await sock.onWhatsApp(formattedNumber);
                const result = onWhatsAppResult?.[0]; // Pega o primeiro resultado, se existir

                if (result?.exists) {
                    sessionLogger.info({ jid: result.jid }, 'Número válido. Criando/verificando chat no DB.');
                    
                    // Garante que o documento do chat exista no Firestore
                    const chatRef = db.collection('users').doc(userId).collection('whatsapp_chats').doc(result.jid);
                    await chatRef.set({
                        name: formattedNumber, // Salva com o número formatado
                        lastMessageTimestamp: new Date(),
                    }, { merge: true });
                    
                    socketIO.emit('number_check_result', {
                        valid: true,
                        jid: result.jid,
                        number: formattedNumber,
                    });
                } else {
                    sessionLogger.warn({ phoneNumber: formattedNumber }, 'Número não encontrado no WhatsApp.');
                    socketIO.emit('number_check_result', {
                        valid: false,
                        error: 'Este número não possui uma conta no WhatsApp.'
                    });
                }
            } catch (error) {
                sessionLogger.error({ error, phoneNumber }, "Erro ao verificar número no WhatsApp.");
                socketIO.emit('number_check_result', {
                    valid: false,
                    error: 'Ocorreu um erro ao verificar o número.'
                });
            }
        }
    });

    socketIO.on('send_message', async ({ contactId, content }: { contactId: string, content: string }) => {
        const sock = sessions.get(userId);
        const sessionLogger = logger.child({ sessionId: userId });

        if (sock && content) {
            try {
                // Envia a mensagem pelo Baileys
                await sock.sendMessage(contactId, { text: content });
                sessionLogger.info({ contactId }, 'Mensagem enviada com sucesso via Baileys.');

                // Salva a mensagem enviada no Firestore
                const messageTimestamp = new Date();
                const chatRef = db.collection('users').doc(userId).collection('whatsapp_chats').doc(contactId);
                
                await chatRef.collection('messages').add({
                    fromMe: true,
                    text: content,
                    timestamp: messageTimestamp,
                });

                // Atualiza as informações do chat
                await chatRef.set({
                    lastMessage: content,
                    lastMessageTimestamp: messageTimestamp,
                }, { merge: true });

            } catch (error) {
                sessionLogger.error({ error, contactId }, "Erro ao enviar mensagem.");
                // Opcional: notificar o frontend sobre o erro
                socketIO.emit('send_error', { contactId, error: 'Falha ao enviar a mensagem.' });
            }
        }
    });

    socketIO.on('logout_session', async () => {
        const sessionLogger = logger.child({ sessionId: userId });
        sessionLogger.info('Recebida solicitação de logout.');
        
        const sock = sessions.get(userId);
        if (sock) {
            try {
                await sock.logout(); // Desconecta do WhatsApp
            } catch (error) {
                sessionLogger.error({ error }, 'Erro ao fazer logout da sessão do Baileys.');
            } finally {
                sessions.delete(userId); // Remove da memória
                
                // Remove a pasta da sessão do disco
                const sessionPath = path.join(SESSIONS_DIR, userId);
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    sessionLogger.info('Pasta da sessão removida do disco.');
                }
            }
        }
        
        // Notifica o cliente que foi desconectado
        socketIO.emit('disconnected', 'Você foi desconectado com sucesso.');
    });

    socketIO.on('request_new_qr', () => {
        const sessionLogger = logger.child({ sessionId: userId });
        sessionLogger.info('Recebida solicitação de novo QR Code.');
        
        // Simplesmente tenta criar um novo socket. A lógica existente em
        // createWhatsAppSocket cuidará da geração de um novo QR code.
        createWhatsAppSocket(userId, socketIO);
    });

    socketIO.on('disconnect', () => {
        logger.info({ userId, socketId: socketIO.id }, 'Cliente desconectado do Socket.IO.');
        userSocketMap.delete(userId);
    });
} 