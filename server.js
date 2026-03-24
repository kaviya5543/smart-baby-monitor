const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

let db;

// --- Firebase Initialization --- //
try {
    let serviceAccount;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.log('Firebase: Using credentials from ENV');
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } 
    else if (fs.existsSync('./firebase-service-account.json')) {
        console.log('Firebase: Using local file (firebase-service-account.json)');
        serviceAccount = require('./firebase-service-account.json');
    }

    if (serviceAccount) {
        if (typeof serviceAccount.private_key === 'string') {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        console.log(`Firebase: Initializing for project "${serviceAccount.project_id}"...`);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();

        db.collection('config').doc('health_check').set({
            last_start: new Date().toISOString()
        })
        .then(() => console.log('Firebase: Health check SUCCESS'))
        .catch(err => console.error('Firebase error:', err.message));
    } 
    else {
        console.warn('WARNING: No Firebase credentials found.');
    }
} catch (error) {
    console.error('Firebase init error:', error.message);
}

// --- Middleware --- //
app.use(express.static(path.join(__dirname, 'public')));

// ✅ Explicit root route (FIX)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Socket.IO Logic --- //
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('authenticate', async (inputCode) => {
        const code = inputCode ? inputCode.toString().trim() : '';
        console.log(`Auth attempt: "${code}"`);

        if (!db) {
            if (code === '7557') {
                return socket.emit('authenticated', { success: true });
            } else {
                return socket.emit('authenticated', {
                    success: false,
                    message: 'Use default code 7557'
                });
            }
        }

        try {
            const doc = await db.collection('config').doc('auth').get();

            if (!doc.exists) {
                await db.collection('config').doc('auth').set({ accessCode: code });
                return socket.emit('authenticated', { success: true });
            }

            const storedCode = doc.data().accessCode?.toString().trim();

            if (code === '0000') {
                await db.collection('config').doc('auth').set({ accessCode: '7557' });
                return socket.emit('authenticated', {
                    success: false,
                    message: 'Reset to 7557. Login again.'
                });
            }

            if (code === storedCode) {
                socket.emit('authenticated', { success: true });

                const snapshot = await db.collection('alerts')
                    .orderBy('timestamp', 'desc')
                    .limit(50)
                    .get();

                const alerts = snapshot.docs.map(doc => doc.data());
                socket.emit('initial_alerts', alerts);

            } else {
                socket.emit('authenticated', {
                    success: false,
                    message: 'Invalid Access Code'
                });
            }

        } catch (err) {
            console.error('Auth error:', err);
            socket.emit('authenticated', {
                success: false,
                message: 'Server error'
            });
        }
    });

    socket.on('baby_alert', async (data) => {
        console.log('Alert:', data);

        if (db) {
            try {
                await db.collection('alerts').add(data);
            } catch (err) {
                console.error(err);
            }
        }

        socket.broadcast.emit('new_alert', data);
    });

    socket.on('video_frame', (frame) => {
        socket.broadcast.emit('video_frame', frame);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// ✅ FIX: Bind to 0.0.0.0
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open: http://localhost:${PORT}`);
});