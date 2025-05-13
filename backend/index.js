import express from 'express';
import bcrypt from 'bcrypt';
import cors from 'cors';
import { openDb } from './db.js';
import jwt from 'jsonwebtoken';

const app = express();

// CORS-Konfiguration
const corsOptions = {
    origin: '*', // In Produktion sollte dies auf deine spezifische Domain beschränkt werden
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'admin-token'],
    credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Überprüfe, ob ADMIN_TOKEN gesetzt ist
if (!ADMIN_TOKEN) {
    console.error('WARNUNG: ADMIN_TOKEN ist nicht in den Umgebungsvariablen gesetzt!');
    console.error('Bitte setzen Sie den ADMIN_TOKEN in Railway unter Variables.');
    console.error('Die Admin-Routen werden ohne Token nicht funktionieren.');
}

// Logging Middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('Fehler:', err);
    res.status(500).json({
        success: false,
        message: 'Ein interner Fehler ist aufgetreten',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Middleware für Rate Limiting
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 Minuten
const MAX_REQUESTS = 100;

app.use((req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, { count: 1, timestamp: now });
    } else {
        const data = rateLimit.get(ip);
        if (now - data.timestamp > RATE_LIMIT_WINDOW) {
            rateLimit.set(ip, { count: 1, timestamp: now });
        } else if (data.count >= MAX_REQUESTS) {
            return res.status(429).json({ 
                success: false, 
                message: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' 
            });
        } else {
            data.count++;
        }
    }
    next();
});

// Security Headers Middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Middleware für Admin-Authentifizierung
const adminAuth = (req, res, next) => {
    const token = req.headers['admin-token'];
    
    if (!ADMIN_TOKEN) {
        console.error('ADMIN_TOKEN ist nicht in den Umgebungsvariablen gesetzt!');
        return res.status(500).json({
            success: false,
            message: 'Server-Konfigurationsfehler: ADMIN_TOKEN nicht gesetzt'
        });
    }
    
    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Admin-Token fehlt im Header'
        });
    }
    
    // Trimme beide Tokens und vergleiche sie
    const trimmedToken = token.trim();
    const trimmedAdminToken = ADMIN_TOKEN.trim();
    
    if (trimmedToken !== trimmedAdminToken) {
        return res.status(401).json({
            success: false,
            message: 'Ungültiger Admin-Token'
        });
    }
    
    next();
};

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Token Validierung Middleware
const validateToken = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Nicht authentifiziert' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Token validation error:', error);
        res.status(401).json({ message: 'Ungültiger Token' });
    }
};

// init DB
(async () => {
    try {
        console.log('Initialisiere Datenbank...');
        const db = await openDb();
        await db.exec(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP,
            failed_attempts INTEGER DEFAULT 0
        )`);

        // Testuser nur erstellen, wenn keine Benutzer existieren
        const userCount = await db.get('SELECT COUNT(*) as count FROM users');
        if (userCount.count === 0) {
            const hash = await bcrypt.hash('passwort123', 12);
            await db.run('INSERT INTO users (username, password) VALUES ($1, $2)', ['test', hash]);
            console.log('Testnutzer erstellt: test / passwort123');
        }
        console.log('Datenbank-Initialisierung abgeschlossen');
    } catch (error) {
        console.error('Fehler bei der Datenbank-Initialisierung:', error);
        process.exit(1); // Beende den Prozess bei Datenbankfehlern
    }
})();

// Validierungsfunktionen
const validateUsername = (username) => {
    if (!username || username.length < 3 || username.length > 20) {
        return false;
    }
    return /^[a-zA-Z0-9_]+$/.test(username);
};

const validatePassword = (password) => {
    if (!password || password.length < 8) {
        return false;
    }
    return true;
};

// Registrierungs-Route
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!validateUsername(username)) {
            return res.status(400).json({
                success: false,
                message: 'Benutzername muss zwischen 3 und 20 Zeichen lang sein und darf nur Buchstaben, Zahlen und Unterstriche enthalten.'
            });
        }

        if (!validatePassword(password)) {
            return res.status(400).json({
                success: false,
                message: 'Passwort muss mindestens 8 Zeichen lang sein.'
            });
        }

        const db = await openDb();
        
        // Prüfen ob Benutzer bereits existiert
        const existingUser = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Dieser Benutzername ist bereits vergeben.'
            });
        }

        const hash = await bcrypt.hash(password, 10);
        await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash]);

        res.status(201).json({
            success: true,
            message: 'Registrierung erfolgreich'
        });
    } catch (error) {
        console.error('Registrierungsfehler:', error);
        res.status(500).json({
            success: false,
            message: 'Ein Fehler ist aufgetreten'
        });
    }
});

// Login-Route
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Benutzer in der Datenbank suchen
        const db = await openDb();
        const user = await db.get('SELECT * FROM users WHERE username = $1', [username]);
        
        if (!user) {
            return res.status(401).json({ message: 'Ungültige Anmeldedaten' });
        }

        // Passwort überprüfen
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            // Fehlgeschlagene Anmeldeversuche aktualisieren
            await db.run(
                'UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1',
                [user.id]
            );
            return res.status(401).json({ message: 'Ungültige Anmeldedaten' });
        }

        // Fehlgeschlagene Anmeldeversuche zurücksetzen
        await db.run(
            'UPDATE users SET failed_attempts = 0, last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        // JWT Token generieren
        const token = jwt.sign(
            { id: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login erfolgreich',
            token,
            user: {
                id: user.id,
                username: user.username
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Admin-Routen
// Alle Benutzer auflisten
app.get('/admin/users', adminAuth, async (req, res) => {
    try {
        const db = await openDb();
        const users = await db.all('SELECT id, username, created_at, last_login FROM users');
        res.json({
            success: true,
            users: users
        });
    } catch (error) {
        console.error('Fehler beim Abrufen der Benutzer:', error);
        res.status(500).json({
            success: false,
            message: 'Ein Fehler ist aufgetreten'
        });
    }
});

// Neuen Benutzer erstellen
app.post('/admin/users', adminAuth, async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Benutzername und Passwort sind erforderlich'
            });
        }

        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({
                success: false,
                message: 'Benutzername muss zwischen 3 und 20 Zeichen lang sein'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Passwort muss mindestens 8 Zeichen lang sein'
            });
        }

        const db = await openDb();
        
        // Prüfen ob Benutzer bereits existiert
        const existingUser = await db.get('SELECT * FROM users WHERE username = $1', [username]);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Dieser Benutzername ist bereits vergeben'
            });
        }

        const hash = await bcrypt.hash(password, 12);
        await db.run('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hash]);

        res.status(201).json({
            success: true,
            message: 'Benutzer erfolgreich erstellt'
        });
    } catch (error) {
        console.error('Fehler beim Erstellen des Benutzers:', error);
        res.status(500).json({
            success: false,
            message: 'Ein Fehler ist aufgetreten'
        });
    }
});

// Benutzer löschen
app.delete('/admin/users/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const db = await openDb();
        
        const result = await db.run('DELETE FROM users WHERE id = $1', [id]);
        
        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Benutzer nicht gefunden'
            });
        }

        res.json({
            success: true,
            message: 'Benutzer erfolgreich gelöscht'
        });
    } catch (error) {
        console.error('Fehler beim Löschen des Benutzers:', error);
        res.status(500).json({
            success: false,
            message: 'Ein Fehler ist aufgetreten'
        });
    }
});

// Passwort zurücksetzen
app.post('/admin/users/:id/reset-password', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword } = req.body;

        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Neues Passwort muss mindestens 8 Zeichen lang sein'
            });
        }

        const db = await openDb();
        const hash = await bcrypt.hash(newPassword, 12);
        
        const result = await db.run(
            'UPDATE users SET password = $1, failed_attempts = 0 WHERE id = $2',
            [hash, id]
        );

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Benutzer nicht gefunden'
            });
        }

        res.json({
            success: true,
            message: 'Passwort erfolgreich zurückgesetzt'
        });
    } catch (error) {
        console.error('Fehler beim Zurücksetzen des Passworts:', error);
        res.status(500).json({
            success: false,
            message: 'Ein Fehler ist aufgetreten'
        });
    }
});

// Termine abrufen
app.get('/appointments', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Nicht authentifiziert' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'Start- und Enddatum erforderlich' });
        }

        const db = await openDb();
        const appointments = await db.getAppointments(decoded.id, startDate, endDate);
        res.json(appointments);
    } catch (error) {
        console.error('Fehler beim Abrufen der Termine:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Neuen Termin erstellen (Admin)
app.post('/appointments', adminAuth, async (req, res) => {
    try {
        const { student_id, date, type } = req.body;

        if (!student_id || !date || !type) {
            return res.status(400).json({ message: 'Alle Felder sind erforderlich' });
        }

        const db = await openDb();
        const appointment = await db.createAppointment({
            student_id,
            date,
            type,
            status: 'suggested'
        });

        res.status(201).json(appointment);
    } catch (error) {
        console.error('Fehler beim Erstellen des Termins:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Termin annehmen
app.put('/appointments/:id/accept', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Nicht authentifiziert' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const appointmentId = req.params.id;

        // Prüfen, ob der Termin dem Benutzer gehört
        const db = await openDb();
        const appointment = await db.get(
            'SELECT * FROM appointments WHERE id = $1 AND student_id = $2',
            [appointmentId, decoded.id]
        );

        if (!appointment) {
            return res.status(404).json({ message: 'Termin nicht gefunden' });
        }

        if (appointment.status !== 'suggested') {
            return res.status(400).json({ message: 'Termin kann nicht mehr angenommen werden' });
        }

        const updatedAppointment = await db.updateAppointmentStatus(appointmentId, 'accepted');
        res.json(updatedAppointment);
    } catch (error) {
        console.error('Fehler beim Annehmen des Termins:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Termin ablehnen
app.put('/appointments/:id/reject', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Nicht authentifiziert' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const appointmentId = req.params.id;

        // Prüfen, ob der Termin dem Benutzer gehört
        const db = await openDb();
        const appointment = await db.get(
            'SELECT * FROM appointments WHERE id = $1 AND student_id = $2',
            [appointmentId, decoded.id]
        );

        if (!appointment) {
            return res.status(404).json({ message: 'Termin nicht gefunden' });
        }

        if (appointment.status !== 'suggested') {
            return res.status(400).json({ message: 'Termin kann nicht mehr abgelehnt werden' });
        }

        const updatedAppointment = await db.updateAppointmentStatus(appointmentId, 'rejected');
        res.json(updatedAppointment);
    } catch (error) {
        console.error('Fehler beim Ablehnen des Termins:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Termin bearbeiten (Admin)
app.put('/appointments/:id', adminAuth, async (req, res) => {
    try {
        const appointmentId = req.params.id;
        const { date, type } = req.body;

        if (!date || !type) {
            return res.status(400).json({ message: 'Datum und Typ sind erforderlich' });
        }

        const db = await openDb();
        const query = `
            UPDATE appointments
            SET date = $1, type = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `;
        const result = await db.run(query, [date, type, appointmentId]);

        if (result.changes === 0) {
            return res.status(404).json({ message: 'Termin nicht gefunden' });
        }

        res.json(result);
    } catch (error) {
        console.error('Fehler beim Bearbeiten des Termins:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Termin löschen (Admin)
app.delete('/appointments/:id', adminAuth, async (req, res) => {
    try {
        const appointmentId = req.params.id;
        const db = await openDb();
        const deletedAppointment = await db.deleteAppointment(appointmentId);

        if (!deletedAppointment) {
            return res.status(404).json({ message: 'Termin nicht gefunden' });
        }

        res.json({ message: 'Termin erfolgreich gelöscht', appointment: deletedAppointment });
    } catch (error) {
        console.error('Fehler beim Löschen des Termins:', error);
        res.status(500).json({ message: 'Interner Serverfehler' });
    }
});

// Debug-Endpunkt (nur für Admin)
app.get('/debug', validateToken, async (req, res) => {
    if (req.user.username !== 'kammersi') {
        return res.status(403).json({ error: 'Nur für Admin zugänglich' });
    }
    
    try {
        const db = await openDb();
        const debugInfo = await db.debugDatabase();
        res.json(debugInfo);
    } catch (error) {
        console.error('Debug endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Starte den Server
app.listen(PORT, () => {
    console.log(`Backend läuft auf Port ${PORT}`);
});