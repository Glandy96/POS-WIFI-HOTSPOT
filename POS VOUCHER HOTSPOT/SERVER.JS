// server.js - Sistema MI SUPERCITO WiFi POS
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { RouterOSAPI } = require('routeros-client');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/vouchers', express.static('vouchers'));
app.use('/portal', express.static('portal'));

// Configuración
const JWT_SECRET = 'mi_supercito_secret_key_2024';
const BUSINESS_NAME = 'MI SUPERCITO';
const WIFI_SSID = 'MI_SUPERCITO_WIFI';

// Configuración Base de Datos
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'password',
    database: 'mi_supercito_wifi'
};

// Configuración MikroTik
const mikrotikConfig = {
    host: '192.168.88.1',
    user: 'admin',
    password: 'mikrotik123',
    port: 8728
};

// ==================== BASE DE DATOS ====================

async function initDB() {
    const connection = await mysql.createConnection(dbConfig);
    
    // Tabla de usuarios (admin/vendedor)
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role ENUM('admin', 'vendedor') DEFAULT 'vendedor',
            active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Tabla de vouchers (lotes pre-generados)
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS vouchers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            pin VARCHAR(20) UNIQUE NOT NULL,
            duration_minutes INT NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            profile VARCHAR(50) NOT NULL,
            batch_id VARCHAR(50),
            status ENUM('available', 'sold', 'used', 'expired') DEFAULT 'available',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            sold_at TIMESTAMP NULL,
            used_at TIMESTAMP NULL,
            sale_type ENUM('store', 'online', 'whatsapp') DEFAULT 'store',
            customer_phone VARCHAR(20),
            customer_name VARCHAR(100),
            seller_id INT,
            mikrotik_user VARCHAR(50),
            FOREIGN KEY (seller_id) REFERENCES users(id)
        )
    `);
    
    // Tabla de lotes
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS batches (
            id INT AUTO_INCREMENT PRIMARY KEY,
            batch_code VARCHAR(50) UNIQUE NOT NULL,
            quantity INT NOT NULL,
            duration_minutes INT NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            profile VARCHAR(50) NOT NULL,
            created_by INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status ENUM('active', 'completed', 'cancelled') DEFAULT 'active',
            FOREIGN KEY (created_by) REFERENCES users(id)
        )
    `);
    
    // Tabla de conversaciones WhatsApp
    await connection.execute(`
        CREATE TABLE IF NOT EXISTS whatsapp_chats (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            response TEXT,
            intent VARCHAR(50),
            context JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved BOOLEAN DEFAULT false
        )
    `);
    
    // Insertar admin por defecto si no existe
    const [admins] = await connection.execute('SELECT id FROM users WHERE role = "admin"');
    if (admins.length === 0) {
        const hashedPass = await bcrypt.hash('admin123', 10);
        await connection.execute(
            'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
            ['admin', hashedPass, 'admin']
        );
    }
    
    return connection;
}

// ==================== MIKROTIK MANAGER ====================

class MikroTikManager {
    constructor() {
        this.client = new RouterOSAPI(mikrotikConfig);
    }

    async connect() {
        try {
            await this.client.connect();
            return true;
        } catch (error) {
            console.error('Error MikroTik:', error);
            return false;
        }
    }

    async createHotspotUser(pin, profile, durationMinutes, name = 'Voucher') {
        try {
            const limitUptime = `${Math.floor(durationMinutes / 60)}h${durationMinutes % 60}m`;
            const comment = `${BUSINESS_NAME} | ${name} | ${new Date().toLocaleString()}`;
            
            const response = await this.client.write('/ip/hotspot/user/add', [
                `=name=${pin}`,
                `=password=${pin}`,
                `=profile=${profile}`,
                `=comment=${comment}`,
                '=disabled=no',
                `=limit-uptime=${limitUptime}`
            ]);
            
            return { success: true, ret: response[0].ret };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async getProfiles() {
        try {
            const profiles = await this.client.write('/ip/hotspot/user/profile/print');
            return profiles.map(p => ({
                name: p.name,
                rateLimit: p['rate-limit'] || 'unlimited',
                sharedUsers: p['shared-users'] || '1'
            }));
        } catch (error) {
            return [];
        }
    }

    async disconnect() {
        await this.client.close();
    }
}

// ==================== GENERADOR DE VOUCHERS ====================

class VoucherGenerator {
    constructor() {
        this.voucherDir = path.join(__dirname, 'vouchers');
        this.logoPath = path.join(__dirname, 'assets', 'logo_MI_SUPERCITO.jpeg');
        if (!fs.existsSync(this.voucherDir)) {
            fs.mkdirSync(this.voucherDir, { recursive: true });
        }
    }

    generatePIN() {
        // Formato: 4 dígitos - 4 dígitos (más fácil de leer)
        const part1 = Math.floor(1000 + Math.random() * 9000);
        const part2 = Math.floor(1000 + Math.random() * 9000);
        return `${part1}-${part2}`;
    }

    async createVoucherImage(voucherData) {
        const { pin, duration, price, profile, batchCode } = voucherData;
        
        const canvas = createCanvas(600, 900);
        const ctx = canvas.getContext('2d');

        // Fondo con colores de MI SUPERCITO (naranja/rojo)
        const gradient = ctx.createLinearGradient(0, 0, 600, 900);
        gradient.addColorStop(0, '#FF6B35'); // Naranja
        gradient.addColorStop(0.5, '#F7931E'); // Naranja claro
        gradient.addColorStop(1, '#E63946'); // Rojo
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 600, 900);

        // Patrón de fondo (carritos estilizados)
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        for(let i=0; i<10; i++) {
            for(let j=0; j<15; j++) {
                ctx.beginPath();
                ctx.arc(i*60, j*60, 20, 0, Math.PI*2);
                ctx.fill();
            }
        }

        // Marco decorativo
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 6;
        ctx.strokeRect(20, 20, 560, 860);
        
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 2;
        ctx.strokeRect(30, 30, 540, 840);

        // Logo MI SUPERCITO
        try {
            if (fs.existsSync(this.logoPath)) {
                const logo = await loadImage(this.logoPath);
                // Logo centrado arriba
                ctx.drawImage(logo, 150, 40, 300, 150);
            }
        } catch (e) {
            console.log('Logo cargado por defecto');
        }

        // Título principal
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 52px Arial';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 10;
        ctx.fillText('MI SUPERCITO', 300, 230);
        
        ctx.font = 'bold 32px Arial';
        ctx.fillText('WIFI ZONE', 300, 270);
        ctx.shadowBlur = 0;

        // Línea separadora decorativa
        ctx.beginPath();
        ctx.moveTo(100, 300);
        ctx.lineTo(500, 300);
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 4;
        ctx.stroke();

        // PIN Grande y destacado
        ctx.font = 'bold 80px Courier New';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(pin, 300, 420);
        
        ctx.font = 'bold 28px Arial';
        ctx.fillStyle = '#FFD700';
        ctx.fillText('CÓDIGO DE ACCESO', 300, 460);

        // Detalles del plan en cajas
        const boxY = 520;
        
        // Duración
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(50, boxY, 500, 60);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 36px Arial';
        ctx.fillText(`⏱️ ${this.formatDuration(duration)}`, 300, boxY + 45);

        // Precio
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(50, boxY + 80, 500, 60);
        ctx.fillStyle = '#FFD700';
        ctx.font = 'bold 40px Arial';
        ctx.fillText(`💰 $${price} MXN`, 300, boxY + 125);

        // Velocidad
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(50, boxY + 160, 500, 60);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 32px Arial';
        ctx.fillText(`⚡ ${profile}`, 300, boxY + 205);

        // Instrucciones
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 24px Arial';
        ctx.fillText('INSTRUCCIONES:', 300, 780);
        
        ctx.font = '22px Arial';
        ctx.fillText('1. Conéctate a: MI_SUPERCITO_WIFI', 300, 815);
        ctx.fillText('2. Ingresa el código de arriba', 300, 845);
        ctx.fillText('3. ¡Disfruta tu navegación!', 300, 875);

        // Lote (si aplica)
        if (batchCode) {
            ctx.font = '16px Arial';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.fillText(`Lote: ${batchCode}`, 300, 890);
        }

        // Guardar
        const fileName = `supercito_${pin.replace('-', '')}_${Date.now()}.png`;
        const filePath = path.join(this.voucherDir, fileName);
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(filePath, buffer);

        return { fileName, filePath, pin, duration, price };
    }

    formatDuration(minutes) {
        if (minutes < 60) return `${minutes} minutos`;
        if (minutes < 1440) return `${Math.floor(minutes/60)} horas`;
        if (minutes === 1440) return '1 día';
        return `${Math.floor(minutes/1440)} días`;
    }
}

// ==================== WHATSAPP BOT AI ====================

class WhatsAppAssistant {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: { headless: true }
        });
        
        this.intents = {
            GREETING: ['hola', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'saludos'],
            PRICE_INQUIRY: ['precio', 'cuanto cuesta', 'tarifa', 'costo', 'vale', 'precios'],
            BUY_REQUEST: ['comprar', 'quiero', 'necesito', 'dame', 'ficha', 'internet', 'wifi'],
            HELP: ['ayuda', 'como funciona', 'no puedo', 'problema', 'ayudame'],
            DURATION: ['tiempo', 'duracion', 'cuanto dura', 'horas', 'minutos', 'vence']
        };
        
        this.responses = {
            greeting: `¡Hola! 👋 Bienvenido a *MI SUPERCITO WIFI* 🛒📶\n\nSoy tu asistente virtual. ¿En qué puedo ayudarte hoy?\n\n💰 *Ver precios*\n🛒 *Comprar ficha*\n❓ *Cómo conectarme*\n📞 *Hablar con humano*`,
            
            prices: `*💰 PRECIOS MI SUPERCITO WIFI:*\n\n` +
                   `⏱️ *1 Hora* - $10\n` +
                   `⏱️ *3 Horas* - $25\n` +
                   `⏱️ *5 Horas* - $40\n` +
                   `📅 *1 Día* - $80\n` +
                   `📅 *1 Semana* - $350\n\n` +
                   `💳 *Métodos de pago:*\n` +
                   `• Efectivo (tienda)\n` +
                   `• Transferencia bancaria\n` +
                   `• OXXO\n\n` +
                   `¿Cuál te interesa? 😊`,
            
            howToConnect: `*📱 CÓMO CONECTARTE:*\n\n` +
                         `1️⃣ Busca la red: *MI_SUPERCITO_WIFI*\n` +
                         `2️⃣ Conéctate (sin contraseña)\n` +
                         `3️⃣ Se abrirá el portal automáticamente\n` +
                         `4️⃣ Ingresa tu código PIN\n` +
                         `5️⃣ ¡Listo! A navegar 🚀\n\n` +
                         `⚠️ Si no abre el portal, abre tu navegador y ve a: *wifi.misupercito.com*`,
            
            buyPrompt: `*🛒 PARA COMPRAR TU FICHA:*\n\n` +
                      `Dime cuál prefieres:\n` +
                      `• 1 hora ($10)\n` +
                      `• 3 horas ($25)\n` +
                      `• 5 horas ($40)\n` +
                      `• 1 día ($80)\n\n` +
                      `Y te indico cómo pagar 💳`
        };
        
        this.contexts = new Map(); // Almacenar contexto por número
        
        this.init();
    }
    
    init() {
        this.client.on('qr', (qr) => {
            qrcode.generate(qr, { small: true });
            console.log('📱 Escanea el QR de WhatsApp Business');
        });
        
        this.client.on('ready', () => {
            console.log('✅ WhatsApp Bot listo - MI SUPERCITO');
        });
        
        this.client.on('message', async (msg) => {
            await this.handleMessage(msg);
        });
        
        this.client.initialize();
    }
    
    async handleMessage(msg) {
        const phone = msg.from.replace('@c.us', '');
        const text = msg.body.toLowerCase().trim();
        
        // Ignorar mensajes de grupos
        if (msg.from.includes('@g.us')) return;
        
        console.log(`📩 ${phone}: ${text}`);
        
        // Guardar en BD
        await this.saveChat(phone, text);
        
        // Detectar intención
        const intent = this.detectIntent(text);
        const context = this.contexts.get(phone) || { step: 'initial' };
        
        let response = '';
        
        // Máquina de estados conversacional
        switch(intent) {
            case 'GREETING':
                response = this.responses.greeting;
                context.step = 'menu';
                break;
                
            case 'PRICE_INQUIRY':
                response = this.responses.prices;
                context.step = 'pricing';
                break;
                
            case 'BUY_REQUEST':
                if (context.step === 'awaiting_payment') {
                    response = await this.processPurchase(phone, text, context);
                } else {
                    response = this.responses.buyPrompt;
                    context.step = 'selecting_plan';
                }
                break;
                
            case 'DURATION':
                response = `⏱️ Las fichas *no vencen* hasta que las uses.\n\nUna vez conectado, el tiempo corre continuamente. Por ejemplo, si compras 3 horas, puedes usar 1 hora hoy y 2 mañana *solo si te desconectas manualmente*.\n\n¿Te gustaría comprar una?`;
                break;
                
            case 'HELP':
                response = this.responses.howToConnect;
                break;
                
            default:
                // Procesamiento contextual
                if (context.step === 'selecting_plan') {
                    const plan = this.extractPlan(text);
                    if (plan) {
                        context.selectedPlan = plan;
                        context.step = 'awaiting_payment';
                        response = `*✅ Has seleccionado:*\n` +
                                  `⏱️ ${plan.duration} - $${plan.price}\n\n` +
                                  `*Para pagar:*\n` +
                                  `💵 *Efectivo:* Pasa a la tienda MI SUPERCITO\n` +
                                  `🏦 *Transferencia:*\n` +
                                  `Banco: BBVA\n` +
                                  `Cuenta: 0123 4567 8901 2345\n` +
                                  `Nombre: Mi Supercito SA\n\n` +
                                  `Envía el *comprobante de pago* (foto o mensaje) y te envío tu ficha inmediatamente 📲`;
                    } else {
                        response = `No entendí bien 😅 ¿Quieres 1 hora, 3 horas, 5 horas o 1 día?`;
                    }
                } else if (context.step === 'awaiting_payment') {
                    // Detectar si envió comprobante (imagen o texto de confirmación)
                    if (msg.hasMedia || text.includes('pague') || text.includes('transferi') || text.includes('deposito')) {
                        response = await this.confirmPayment(phone, context);
                    } else {
                        response = `Esperando tu comprobante de pago... 💳\n\n¿Necesitas más tiempo o cambiaste de opinión?`;
                    }
                } else {
                    response = `Entiendo 😊 ¿Puedes ser más específico?\n\nPuedo ayudarte con:\n💰 Precios\n🛒 Comprar ficha\n❓ Cómo conectarte\n\nO escribe *ayuda* para ver opciones.`;
                }
        }
        
        // Enviar respuesta
        await msg.reply(response);
        
        // Guardar contexto
        this.contexts.set(phone, context);
        
        // Actualizar BD con respuesta
        await this.saveChat(phone, text, response, intent);
    }
    
    detectIntent(text) {
        for (const [intent, keywords] of Object.entries(this.intents)) {
            if (keywords.some(k => text.includes(k))) {
                return intent;
            }
        }
        return 'UNKNOWN';
    }
    
    extractPlan(text) {
        const plans = [
            { keywords: ['1 hora', 'una hora', '1hora'], duration: '1 Hora', minutes: 60, price: 10 },
            { keywords: ['3 horas', 'tres horas', '3horas'], duration: '3 Horas', minutes: 180, price: 25 },
            { keywords: ['5 horas', 'cinco horas', '5horas'], duration: '5 Horas', minutes: 300, price: 40 },
            { keywords: ['1 dia', 'un dia', 'dia completo', '24 horas'], duration: '1 Día', minutes: 1440, price: 80 },
            { keywords: ['semana', '7 dias', 'una semana'], duration: '1 Semana', minutes: 10080, price: 350 }
        ];
        
        for (const plan of plans) {
            if (plan.keywords.some(k => text.includes(k))) {
                return plan;
            }
        }
        return null;
    }
    
    async confirmPayment(phone, context) {
        try {
            // Buscar voucher disponible del lote
            const connection = await initDB();
            const [vouchers] = await connection.execute(
                'SELECT * FROM vouchers WHERE status = "available" AND duration_minutes = ? LIMIT 1',
                [context.selectedPlan.minutes]
            );
            
            if (vouchers.length === 0) {
                // Generar uno nuevo si no hay en lote
                return `¡Ups! 😅 Se acabaron las fichas de ${context.selectedPlan.duration} en este momento.\n\nUn momento... generando una especial para ti... ⏳`;
            }
            
            const voucher = vouchers[0];
            
            // Marcar como vendido
            await connection.execute(
                'UPDATE vouchers SET status = "sold", sale_type = "whatsapp", customer_phone = ?, sold_at = NOW() WHERE id = ?',
                [phone, voucher.id]
            );
            
            // Enviar imagen del voucher
            const voucherPath = path.join(__dirname, 'vouchers', voucher.image_path);
            if (fs.existsSync(voucherPath)) {
                const media = MessageMedia.fromFilePath(voucherPath);
                await this.client.sendMessage(phone + '@c.us', media, { caption: `🎉 *¡Tu ficha está lista!*` });
            }
            
            // Limpiar contexto
            this.contexts.delete(phone);
            
            return `*✅ PAGO CONFIRMADO*\n\n` +
                   `🔑 *CÓDIGO:* ${voucher.pin}\n` +
                   `⏱️ *DURACIÓN:* ${context.selectedPlan.duration}\n\n` +
                   `*Instrucciones:*\n` +
                   `1️⃣ Conéctate a *MI_SUPERCITO_WIFI*\n` +
                   `2️⃣ Ingresa el código: *${voucher.pin}*\n` +
                   `3️⃣ ¡Navega!\n\n` +
                   `¿Necesitas ayuda para conectarte? Escríbeme *ayuda* 📱\n\n` +
                   `¡Gracias por elegir MI SUPERCITO! 🛒❤️`;
                   
        } catch (error) {
            console.error('Error confirmando pago:', error);
            return `Hubo un problema generando tu ficha 😓 Por favor, contacta a la tienda o intenta de nuevo en unos minutos.`;
        }
    }
    
    async saveChat(phone, message, response = null, intent = null) {
        try {
            const connection = await initDB();
            await connection.execute(
                'INSERT INTO whatsapp_chats (phone, message, response, intent) VALUES (?, ?, ?, ?)',
                [phone, message, response, intent]
            );
        } catch (e) {
            console.error('Error guardando chat:', e);
        }
    }
    
    // Enviar mensaje proactivo (para marketing)
    async sendPromo(phone, message) {
        await this.client.sendMessage(phone + '@c.us', message);
    }
}

// ==================== MIDDLEWARE AUTH ====================

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Requiere permisos de administrador' });
    }
    next();
};

// ==================== API ROUTES ====================

const voucherGen = new VoucherGenerator();
let whatsappBot;

// Iniciar WhatsApp Bot
setTimeout(() => {
    whatsappBot = new WhatsAppAssistant();
}, 5000);

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const connection = await initDB();
        const [users] = await connection.execute('SELECT * FROM users WHERE username = ?', [username]);
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Usuario no encontrado' });
        }
        
        const user = users[0];
        const validPass = await bcrypt.compare(password, user.password);
        
        if (!validPass) {
            return res.status(401).json({ error: 'Contraseña incorrecta' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        
        res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Crear lote de vouchers (SOLO ADMIN)
app.post('/api/batches/create', authenticate, requireAdmin, async (req, res) => {
    try {
        const { quantity, duration, price, profile } = req.body;
        const connection = await initDB();
        
        const batchCode = `BATCH-${Date.now()}`;
        const vouchers = [];
        
        // Crear lote en BD
        const [batchResult] = await connection.execute(
            'INSERT INTO batches (batch_code, quantity, duration_minutes, price, profile, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [batchCode, quantity, duration, price, profile, req.user.id]
        );
        
        // Generar vouchers individualmente
        const mt = new MikroTikManager();
        await mt.connect();
        
        for (let i = 0; i < quantity; i++) {
            let pin = voucherGen.generatePIN();
            
            // Verificar unicidad
            let [existing] = await connection.execute('SELECT id FROM vouchers WHERE pin = ?', [pin]);
            while (existing.length > 0) {
                pin = voucherGen.generatePIN();
                [existing] = await connection.execute('SELECT id FROM vouchers WHERE pin = ?', [pin]);
            }
            
            // Crear en MikroTik
            const mtResult = await mt.createHotspotUser(pin, profile, duration, `Lote ${batchCode}`);
            
            if (mtResult.success) {
                // Generar imagen
                const voucherImg = await voucherGen.createVoucherImage({
                    pin,
                    duration,
                    price,
                    profile,
                    batchCode
                });
                
                // Guardar en BD
                await connection.execute(
                    'INSERT INTO vouchers (pin, duration_minutes, price, profile, batch_id, mikrotik_user, image_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [pin, duration, price, profile, batchCode, pin, voucherImg.fileName]
                );
                
                vouchers.push({ pin, image: voucherImg.fileName });
            }
        }
        
        await mt.disconnect();
        
        res.json({
            success: true,
            batchCode,
            quantity: vouchers.length,
            vouchers
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Vendedor: Obtener vouchers disponibles para venta rápida
app.get('/api/vouchers/available', authenticate, async (req, res) => {
    try {
        const connection = await initDB();
        const [vouchers] = await connection.execute(
            'SELECT id, pin, duration_minutes, price, profile FROM vouchers WHERE status = "available" ORDER BY created_at DESC LIMIT 50'
        );
        
        // Agrupar por plan
        const grouped = vouchers.reduce((acc, v) => {
            const key = `${v.duration_minutes}-${v.price}`;
            if (!acc[key]) {
                acc[key] = {
                    duration: v.duration_minutes,
                    price: v.price,
                    profile: v.profile,
                    count: 0,
                    vouchers: []
                };
            }
            acc[key].count++;
            acc[key].vouchers.push({ id: v.id, pin: v.pin });
            return acc;
        }, {});
        
        res.json(Object.values(grouped));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Vendedor: Vender voucher (activación instantánea)
app.post('/api/vouchers/sell', authenticate, async (req, res) => {
    try {
        const { voucherId, saleType, customerPhone, customerName } = req.body;
        const connection = await initDB();
        
        // Verificar que esté disponible
        const [vouchers] = await connection.execute(
            'SELECT * FROM vouchers WHERE id = ? AND status = "available"',
            [voucherId]
        );
        
        if (vouchers.length === 0) {
            return res.status(400).json({ error: 'Voucher no disponible' });
        }
        
        const voucher = vouchers[0];
        
        // Marcar como vendido
        await connection.execute(
            'UPDATE vouchers SET status = "sold", sale_type = ?, customer_phone = ?, customer_name = ?, seller_id = ?, sold_at = NOW() WHERE id = ?',
            [saleType, customerPhone, customerName, req.user.id, voucherId]
        );
        
        // Registrar venta
        await connection.execute(
            'INSERT INTO sales (voucher_id, amount, seller_id, payment_method) VALUES (?, ?, ?, ?)',
            [voucherId, voucher.price, req.user.id, 'cash']
        );
        
        // Generar imagen si no existe
        const imagePath = path.join(__dirname, 'vouchers', voucher.image_path || '');
        let imageUrl = null;
        
        if (!fs.existsSync(imagePath)) {
            const newImg = await voucherGen.createVoucherImage({
                pin: voucher.pin,
                duration: voucher.duration_minutes,
                price: voucher.price,
                profile: voucher.profile
            });
            imageUrl = `/vouchers/${newImg.fileName}`;
        } else {
            imageUrl = `/vouchers/${voucher.image_path}`;
        }
        
        res.json({
            success: true,
            voucher: {
                pin: voucher.pin,
                duration: voucher.duration_minutes,
                price: voucher.price,
                imageUrl: imageUrl
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Estadísticas
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const connection = await initDB();
        
        // Ventas hoy
        const [todaySales] = await connection.execute(`
            SELECT COUNT(*) as count, COALESCE(SUM(v.price), 0) as revenue 
            FROM vouchers v 
            WHERE DATE(v.sold_at) = CURDATE() AND v.status = 'sold'
        `);
        
        // Vouchers disponibles
        const [available] = await connection.execute(
            'SELECT COUNT(*) as count FROM vouchers WHERE status = "available"'
        );
        
        // Por tipo
        const [byType] = await connection.execute(`
            SELECT duration_minutes, price, COUNT(*) as count 
            FROM vouchers WHERE status = "available" 
            GROUP BY duration_minutes, price
        `);
        
        res.json({
            todaySales: todaySales[0],
            available: available[0].count,
            byType
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obtener perfiles MikroTik
app.get('/api/profiles', authenticate, async (req, res) => {
    try {
        const mt = new MikroTikManager();
        await mt.connect();
        const profiles = await mt.getProfiles();
        await mt.disconnect();
        res.json(profiles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MI SUPERCITO WiFi POS corriendo en puerto ${PORT}`);
    console.log(`📱 WhatsApp Bot iniciando...`);
});