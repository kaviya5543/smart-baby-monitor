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
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.log('Using Firebase from ENV');

        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

        // ✅ FIX: Handle newline issue properly
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        console.log('Firebase initialized (ENV)');
    }
    else if (fs.existsSync('./firebase-service-account.json')) {
        console.log('Using local Firebase JSON');

        const serviceAccount = require('./firebase-service-account.json');

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        console.log('Firebase initialized (LOCAL)');
    }
    else {
        console.warn('No Firebase credentials found');
    }
} catch (error) {
    console.error('Firebase init error:', error);
}

// --- Middleware --- //
app.use(express.static('public'));

// --- Socket.IO --- //
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('authenticate', async (inputCode) => {
        const code = inputCode?.toString().trim();

        if (!db) {
            // fallback
            if (code === '7557') {
                return socket.emit('authenticated', { success: true });
            } else {
                return socket.emit('authenticated', {
                    success: false,
                    message: 'Firebase not connected. Use default code 7557.'
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

            if (code === storedCode) {
                socket.emit('authenticated', { success: true });

                // send alerts
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
                message: 'Server error during authentication'
            });
        }
    });

    socket.on('baby_alert', async (data) => {
        if (db) {
            try {
                await db.collection('alerts').add(data);
            } catch (err) {
                console.error('Save alert error:', err);
            }
        }
        socket.broadcast.emit('new_alert', data);
    });

    socket.on('expression_alert', async (data) => {
        socket.broadcast.emit('new_expression', data);

        if (db) {
            try {
                const snapshot = await db.collection('alerts')
                    .where('type', '==', 'Baby Cry')
                    .orderBy('timestamp', 'desc')
                    .limit(1)
                    .get();

                if (!snapshot.empty) {
                    const docId = snapshot.docs[0].id;
                    await db.collection('alerts').doc(docId).update({
                        subType: data.reason
                    });
                }
            } catch (err) {
                console.error('Expression update error:', err);
            }
        }
    });

    socket.on('video_frame', (frame) => {
        socket.broadcast.emit('video_frame', frame);
    });

    socket.on('delete_history', async () => {
        if (db) {
            try {
                const snapshot = await db.collection('alerts').get();
                const batch = db.batch();

                snapshot.forEach(doc => batch.delete(doc.ref));
                await batch.commit();

            } catch (err) {
                console.error('Delete error:', err);
            }
        }
        io.emit('history_deleted');
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// --- Start Server --- //
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});