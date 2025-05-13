import pg from 'pg';
const { Pool } = pg;

// Debug: Zeige die Datenbank-URL (ohne Passwort)
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
    console.error('DATABASE_URL ist nicht gesetzt! Bitte überprüfen Sie die Railway-Konfiguration.');
    process.exit(1);
}

// Erstelle einen Pool mit den Umgebungsvariablen von Railway
const pool = new Pool({
    connectionString: dbUrl,
    ssl: {
        rejectUnauthorized: false
    },
    // Verbindungsoptionen
    connectionTimeoutMillis: 5000, // 5 Sekunden Timeout
    idleTimeoutMillis: 30000, // 30 Sekunden
    max: 20 // Maximale Anzahl der Verbindungen im Pool
});

// Teste die Datenbankverbindung
pool.on('error', (err) => {
    console.error('Unerwarteter Fehler bei der Datenbankverbindung:', err);
    // Versuche die Verbindung neu aufzubauen
    setTimeout(() => {
        console.log('Versuche Datenbankverbindung neu aufzubauen...');
        pool.connect().catch(err => {
            console.error('Fehler beim Neuaufbau der Verbindung:', err);
        });
    }, 5000);
});

// Wrapper für die Datenbankoperationen
export async function openDb() {
    let retries = 5;
    while (retries > 0) {
        try {
            console.log(`Versuche Datenbankverbindung herzustellen... (${retries} Versuche übrig)`);
            const client = await pool.connect();
            try {
                // Teste die Verbindung
                await client.query('SELECT NOW()');
                console.log('Datenbankverbindung erfolgreich hergestellt');
                
                // Erstelle die users-Tabelle, falls sie nicht existiert
                await client.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        id SERIAL PRIMARY KEY,
                        username TEXT UNIQUE NOT NULL,
                        password TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        last_login TIMESTAMP,
                        failed_attempts INTEGER DEFAULT 0
                    );
                `);
                console.log('Users-Tabelle wurde erfolgreich erstellt oder existiert bereits');

                // Erstelle die appointments-Tabelle, falls sie nicht existiert
                await client.query(`
                    CREATE TABLE IF NOT EXISTS appointments (
                        id SERIAL PRIMARY KEY,
                        student_id INTEGER REFERENCES users(id),
                        date TIMESTAMP NOT NULL,
                        type VARCHAR(50) NOT NULL,
                        status VARCHAR(20) NOT NULL CHECK (status IN ('suggested', 'accepted', 'rejected')),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                console.log('Appointments-Tabelle wurde erfolgreich erstellt oder existiert bereits');
                
                client.release();
                break;
            } catch (err) {
                client.release();
                throw err;
            }
        } catch (error) {
            console.error('Fehler bei der Datenbankverbindung:', error);
            retries--;
            if (retries === 0) {
                console.error('Keine Verbindung zur Datenbank möglich. Bitte überprüfen Sie:');
                console.error('1. Ist die DATABASE_URL korrekt gesetzt?');
                console.error('2. Ist die PostgreSQL-Datenbank in Railway aktiv?');
                console.error('3. Sind die Netzwerkeinstellungen korrekt?');
                throw new Error('Datenbankverbindung fehlgeschlagen: ' + error.message);
            }
            // Warte 5 Sekunden vor dem nächsten Versuch
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    return {
        // Führt eine SQL-Abfrage aus und gibt alle Ergebnisse zurück
        all: async (sql, params = []) => {
            const client = await pool.connect();
            try {
                const result = await client.query(sql, params);
                return result.rows;
            } catch (error) {
                console.error('Fehler bei Datenbankabfrage (all):', error);
                throw error;
            } finally {
                client.release();
            }
        },

        // Führt eine SQL-Abfrage aus und gibt das erste Ergebnis zurück
        get: async (sql, params = []) => {
            const client = await pool.connect();
            try {
                const result = await client.query(sql, params);
                return result.rows[0];
            } catch (error) {
                console.error('Fehler bei Datenbankabfrage (get):', error);
                throw error;
            } finally {
                client.release();
            }
        },

        // Führt eine SQL-Abfrage aus und gibt das Ergebnis zurück
        run: async (sql, params = []) => {
            const client = await pool.connect();
            try {
                const result = await client.query(sql, params);
                return {
                    changes: result.rowCount,
                    lastID: result.rows[0]?.id
                };
            } catch (error) {
                console.error('Fehler bei Datenbankabfrage (run):', error);
                throw error;
            } finally {
                client.release();
            }
        },

        // Führt eine SQL-Abfrage aus
        exec: async (sql) => {
            const client = await pool.connect();
            try {
                await client.query(sql);
            } catch (error) {
                console.error('Fehler bei Datenbankabfrage (exec):', error);
                throw error;
            } finally {
                client.release();
            }
        },

        // Spezielle Funktionen für Appointments
        getAppointments: async (studentId, startDate, endDate) => {
            const client = await pool.connect();
            try {
                // Debug: Zeige alle Termine in der Datenbank
                const allAppointments = await client.query('SELECT * FROM appointments');
                console.log('Alle Termine in der Datenbank:', allAppointments.rows);

                // Debug: Zeige alle Benutzer in der Datenbank
                const allUsers = await client.query('SELECT * FROM users');
                console.log('Alle Benutzer in der Datenbank:', allUsers.rows);

                const query = `
                    SELECT 
                        a.*,
                        u.username as student_name,
                        a.date AT TIME ZONE 'Europe/Berlin' as date
                    FROM appointments a
                    JOIN users u ON a.student_id = u.id
                    WHERE a.student_id = $1
                    AND a.date >= $2::timestamp
                    AND a.date <= $3::timestamp
                    ORDER BY a.date ASC
                `;
                console.log('SQL Query:', query);
                console.log('Query parameters:', { studentId, startDate, endDate });
                
                const result = await client.query(query, [studentId, startDate, endDate]);
                console.log('Query result:', result.rows);
                return result.rows;
            } catch (error) {
                console.error('Fehler beim Abrufen der Termine:', error);
                throw error;
            } finally {
                client.release();
            }
        },

        createAppointment: async (appointment) => {
            const client = await pool.connect();
            try {
                const query = `
                    INSERT INTO appointments 
                    (student_id, date, type, status, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    RETURNING *
                `;
                const result = await client.query(query, [
                    appointment.student_id,
                    appointment.date,
                    appointment.type,
                    appointment.status
                ]);
                return result.rows[0];
            } catch (error) {
                console.error('Fehler beim Erstellen des Termins:', error);
                throw error;
            } finally {
                client.release();
            }
        },

        updateAppointmentStatus: async (appointmentId, status) => {
            const client = await pool.connect();
            try {
                const query = `
                    UPDATE appointments
                    SET status = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                    RETURNING *
                `;
                const result = await client.query(query, [status, appointmentId]);
                return result.rows[0];
            } catch (error) {
                console.error('Fehler beim Aktualisieren des Terminstatus:', error);
                throw error;
            } finally {
                client.release();
            }
        },

        deleteAppointment: async (appointmentId) => {
            const client = await pool.connect();
            try {
                const query = `
                    DELETE FROM appointments
                    WHERE id = $1
                    RETURNING *
                `;
                const result = await client.query(query, [appointmentId]);
                return result.rows[0];
            } catch (error) {
                console.error('Fehler beim Löschen des Termins:', error);
                throw error;
            } finally {
                client.release();
            }
        },

        // Debug-Funktion zum Überprüfen der Datenbank
        debugDatabase: async () => {
            const client = await pool.connect();
            try {
                // Überprüfe users Tabelle
                const usersResult = await client.query('SELECT * FROM users');
                console.log('Users in database:', usersResult.rows);

                // Überprüfe appointments Tabelle
                const appointmentsResult = await client.query('SELECT * FROM appointments');
                console.log('Appointments in database:', appointmentsResult.rows);

                // Korrigiere das Datum des Termins
                await client.query(`
                    UPDATE appointments 
                    SET date = '2025-05-12 14:00:00'::timestamp 
                    WHERE id = 1
                `);
                console.log('Termin-Datum wurde korrigiert');

                // Überprüfe die spezifische Abfrage
                const testQuery = `
                    SELECT a.*, u.username as student_name
                    FROM appointments a
                    JOIN users u ON a.student_id = u.id
                    WHERE a.date >= '2025-05-12'::timestamp
                    AND a.date <= '2025-05-18'::timestamp
                    ORDER BY a.date ASC
                `;
                const testResult = await client.query(testQuery);
                console.log('Test query result:', testResult.rows);

                return {
                    users: usersResult.rows,
                    appointments: appointmentsResult.rows,
                    testQuery: testResult.rows
                };
            } catch (error) {
                console.error('Debug database error:', error);
                throw error;
            } finally {
                client.release();
            }
        }
    };
}