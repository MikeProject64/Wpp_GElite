import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
dotenv.config(); // Carrega as variáveis de ambiente

import logger from './logger';
import { initWhatsApp } from './whatsappService';
import { verifyFirebaseToken } from './firebaseAdmin';


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL, // Usando variável de ambiente
    }
});

app.get('/', (req, res) => {
    res.send('WhatsApp Backend is running!');
});

io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Novo cliente conectado.');

    socket.on('auth', async (token) => {
        logger.info({ socketId: socket.id }, 'Recebido token para autenticação.');
        const uid = await verifyFirebaseToken(token);

        if (uid) {
            logger.info({ socketId: socket.id, userId: uid }, 'Token válido. Iniciando sessão de WhatsApp.');
            initWhatsApp(socket, io, uid);
        } else {
            logger.warn({ socketId: socket.id }, 'Token inválido. Desconectando socket.');
            socket.emit('auth_error', 'Token de autenticação inválido.');
            socket.disconnect();
        }
    });

    socket.on('disconnect', () => {
        logger.info({ socketId: socket.id }, 'Cliente desconectado.');
        // A lógica de limpeza agora é tratada no whatsappService
    });
});


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
}); 