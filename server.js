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

// Dynamic access code will be fetched from Firestore
let currentAccessCode = null;
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
        // diagnostic: check for private key issues
        if (!serviceAccount.private_key || !serviceAccount.private_key.includes('BEGIN PRIVATE KEY')) {
            console.error('Firebase: ERROR - Private key is missing or invalid format!');
        } else {
            // Apply newline fix
            if (typeof serviceAccount.private_key === 'string') {
                const originalKey = serviceAccount.private_key;
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                if (originalKey !== serviceAccount.private_key) {
                    console.log('Firebase: Applied newline formatting to private_key');
                }
            }
        }

        console.log(`Firebase: Initializing for project "${serviceAccount.project_id}"...`);
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        
        // Immediate check to verify if the account is actually working
        db.collection('config').doc('health_check').set({ last_start: new Date().toISOString() })
            .then(() => console.log('Firebase: Health check SUCCESS - Connection is fully authenticated'))
            .catch(err => {
                console.error('Firebase: Health check FAILED - Credentials rejected by Google');
                console.error('Details:', err.message);
                if (err.message.includes('auth')) {
                    console.error('HINT: Check if the service account is disabled or the key is revoked in GCP Console.');
                }
            });
    } 
    else {
        console.warn('WARNING: No Firebase credentials found. Database features will be disabled.');
    }
} catch (error) {
    console.error('Firebase: Initialization crash:', error.message);
    if (error.stack) console.error(error.stack);
}

// --- Middleware --- //
app.use(express.static('public'));

// --- Socket.IO Logic --- //
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('authenticate', async (inputCode) => {
        const code = inputCode ? inputCode.toString().trim() : '';
        console.log(`Authentication attempt with code: "${code}"`);

        if (!db) {
            console.log('Firebase not initialized. Falling back to default code.');
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
                console.log('Firebase: No access code set yet. Setting initial code:', code);
                await db.collection('config').doc('auth').set({ accessCode: code });
                return socket.emit('authenticated', { success: true });
            }

            const storedCode = doc.data().accessCode?.toString().trim();
            console.log(`Firebase: Auth Check - Input: "${code}", Stored: "${storedCode}"`);

            // Master Reset: If user types "0000", reset the code in database
            if (code === '0000') {
                console.warn('Firebase: Master Reset Code used. Resetting code to default (7557)');
                await db.collection('config').doc('auth').set({ accessCode: '7557' });
                return socket.emit('authenticated', { 
                    success: false, 
                    message: 'Code has been reset to 7557. Please log in with 7557.' 
                });
            }

            if (code === storedCode) {
                console.log('Firebase: Authentication successful');
                socket.emit('authenticated', { success: true });

                // Send alerts
                const snapshot = await db.collection('alerts')
                    .orderBy('timestamp', 'desc')
                    .limit(50)
                    .get();

                const alerts = snapshot.docs.map(doc => doc.data());
                socket.emit('initial_alerts', alerts);

            } else {
                console.log(`Authentication failed: mismatch ("${code}" vs "${storedCode}")`);
                socket.emit('authenticated', {
                    success: false,
                    message: 'Invalid Access Code'
                });
            }

        } catch (err) {
            console.error('Authentication error details:', err);
            socket.emit('authenticated', {
                success: false,
                message: 'Server error during authentication'
            });
        }
    });

    socket.on('baby_alert', async (data) => {
        console.log('New alert:', data);
        if (db) {
            try {
                await db.collection('alerts').add(data);
                console.log('Alert stored in Firebase');
            } catch (err) {
                console.error('Error storing alert:', err);
            }
        }
        socket.broadcast.emit('new_alert', data);
    });

    socket.on('expression_alert', async (data) => {
        console.log('New expression:', data);
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
                    console.log('Expression reason updated in Firebase');
                }
            } catch (err) {
                console.error('Error updating expression in Firebase:', err);
            }
        }
    });

    socket.on('video_frame', (frame) => {
        socket.broadcast.emit('video_frame', frame);
    });

    socket.on('delete_history', async () => {
        console.log('Deleting history...');
        if (db) {
            try {
                const snapshot = await db.collection('alerts').get();
                const batch = db.batch();

                snapshot.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                console.log('History purged in Firebase');

            } catch (err) {
                console.error('Error deleting history:', err);
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
    console.log(`Local URL: http://localhost:${PORT}`);
});
