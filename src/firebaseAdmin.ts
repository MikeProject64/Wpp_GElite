import * as admin from 'firebase-admin';
import * as path from 'path';
import logger from './logger';

let db: admin.firestore.Firestore;

// Caminho para o arquivo da chave da conta de serviço
const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');

try {
    const serviceAccount = require(serviceAccountPath);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore(); // Obtém a referência do Firestore

    logger.info('Firebase Admin SDK inicializado com sucesso.');

} catch (error) {
    logger.error({ error }, 'Erro ao inicializar o Firebase Admin SDK.');
    logger.error('Certifique-se de que o arquivo "serviceAccountKey.json" existe na raiz do diretório "whatsapp-backend".');
    process.exit(1);
}

/**
 * Verifica um token de ID do Firebase e retorna o UID do usuário.
 * @param token O token de ID do Firebase a ser verificado.
 * @returns O UID do usuário se o token for válido, caso contrário, null.
 */
export async function verifyFirebaseToken(token: string): Promise<string | null> {
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        return decodedToken.uid;
    } catch (error) {
        logger.error({ error, token }, 'Erro ao verificar o token do Firebase.');
        return null;
    }
}

export { db, admin }; 