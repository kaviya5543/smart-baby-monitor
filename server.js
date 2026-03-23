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

// --- Firebase Initialization --- //
let db;
const serviceAccountPath = './firebase-service-account.json';

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        console.log('Detected FIREBASE_SERVICE_ACCOUNT environment variable.');
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            
            // Robustly handle escaped newlines in private key
            if (serviceAccount.private_key && typeof serviceAccount.private_key === 'string') {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }

            console.log('JSON parsing of FIREBASE_SERVICE_ACCOUNT successful.');
            console.log('Project ID from Env Var:', serviceAccount.project_id);
            console.log('Client Email from Env Var:', serviceAccount.client_email);
            
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            db = admin.firestore();
            console.log('Firebase initialized (Env Var)');
        } catch (jsonError) {
            console.error('JSON parsing error for FIREBASE_SERVICE_ACCOUNT:', jsonError.message);
            console.log('Raw Env Var length:', process.env.FIREBASE_SERVICE_ACCOUNT.length);
            console.log('First 50 chars of Env Var:', process.env.FIREBASE_SERVICE_ACCOUNT.substring(0, 50));
        }
    } else if (fs.existsSync(serviceAccountPath)) {
        console.log('Using firebase-service-account.json');
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('Firebase initialized (JSON File)');
    } else {
        console.warn('WARNING: No Firebase credentials found. Database features will be disabled.');
    }
} catch (error) {
    console.error('General Firebase initialization error:', error);
}

// --- Middleware --- //
app.use(express.static('public'));

// --- Socket.IO Logic --- //
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('authenticate', async (inputCode) => {
        const code = inputCode ? inputCode.toString().trim() : '';
        console.log(`Authentication attempt with code: "${code}"`);
        
        if (!db) {
            console.log('Firebase not initialized. Falling back to default code.');
            if (code === '7557') {
                socket.emit('authenticated', { success: true });
            } else {
                socket.emit('authenticated', { success: false, message: 'Firebase not connected. Use default code 7557.' });
            }
            return;
        }

        try {
            const authDoc = await db.collection('config').doc('auth').get();
            
            if (!authDoc.exists) {
                console.log('No access code set yet. Setting first code:', code);
                await db.collection('config').doc('auth').set({ accessCode: code });
                socket.emit('authenticated', { success: true });
            } else {
                const storedCode = authDoc.data().accessCode.toString().trim();
                console.log(`Stored code found: "${storedCode}"`);
                
                if (code === storedCode) {
                    console.log('Authentication successful');
                    socket.emit('authenticated', { success: true });
                    
                    // Send initial alerts
                    db.collection('alerts')
                        .orderBy('timestamp', 'desc')
                        .limit(50)
                        .get()
                        .then(snapshot => {
                            const alerts = [];
                            snapshot.forEach(doc => alerts.push(doc.data()));
                            socket.emit('initial_alerts', alerts);
                        })
                        .catch(err => console.error('Error fetching initial alerts:', err));
                } else {
                    console.log(`Authentication failed: mismatch ("${code}" vs "${storedCode}")`);
                    socket.emit('authenticated', { success: false, message: 'Invalid Access Code' });
                }
            }
        } catch (err) {
            console.error('Authentication error details:', err);
            socket.emit('authenticated', { success: false, message: 'Server error during authentication' });
        }
    });

    socket.on('baby_alert', async (alertData) => {
        console.log('New alert:', alertData);
        
        // Store in Firebase
        if (db) {
            try {
                await db.collection('alerts').add(alertData);
                console.log('Alert stored in Firebase');
            } catch (err) {
                console.error('Error storing alert:', err);
            }
        }
        
        // Broadcast to all clients (Mother Dashboard)
        socket.broadcast.emit('new_alert', alertData);
    });

    socket.on('expression_alert', async (expressionData) => {
        console.log('New expression:', expressionData);
        
        // Broadcast to all clients
        socket.broadcast.emit('new_expression', expressionData);
        
        // Optional: Update the last alert in Firebase with this reason
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
                        subType: expressionData.reason
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

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
