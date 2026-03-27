const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// Initialize Firebase Admin
let db;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production: Use environment variable
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin initialized via environment variable.');
    } else {
        // Local: Use service account file
        const fs = require('fs');
        let serviceAccountPath;
        
        // Check for both common misnamings or the correct one
        if (fs.existsSync(path.join(__dirname, 'firebase-service-account.json.json'))) {
            serviceAccountPath = './firebase-service-account.json.json';
        } else if (fs.existsSync(path.join(__dirname, 'firebase-service-account.json'))) {
            serviceAccountPath = './firebase-service-account.json';
        }

        if (serviceAccountPath) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log(`Firebase Admin initialized via local file: ${serviceAccountPath}`);
        } else {
            const isProduction = process.env.NODE_ENV === 'production';
            if (isProduction) {
                console.error('CRITICAL: FIREBASE_SERVICE_ACCOUNT environment variable is missing in production!');
            } else {
                console.error('CRITICAL: Firebase service account file not found locally (expected firebase-service-account.json).');
            }
            throw new Error('Missing Firebase credentials');
        }
    }
    db = admin.firestore();
} catch (error) {
    console.error('CRITICAL: Firebase initialization failed:', error.message);
    console.error('The server cannot start without a valid Firebase connection.');
    console.error('Ensure the FIREBASE_SERVICE_ACCOUNT environment variable is set correctly in production,');
    console.error('or that firebase-service-account.json exists locally.');
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint — verifies Firebase is reachable
app.get('/health', async (req, res) => {
    try {
        // A lightweight probe: fetch a non-existent doc just to confirm connectivity
        await db.collection('_health').doc('ping').get();
        res.status(200).json({ status: 'ok', firebase: 'connected' });
    } catch (err) {
        console.error('Health check: Firebase probe failed:', err.message);
        res.status(503).json({ status: 'error', firebase: 'unreachable', detail: err.message });
    }
});

let currentAccessCode = process.env.ACCESS_CODE || '1234';
let babySocketId = null;

// Helper to update access code in Firestore
async function updateStoredAccessCode(newCode) {
    if (!db) return;
    try {
        await db.collection('settings').doc('access_code').set({
            code: newCode,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Access code updated in Firestore: ${newCode}`);
    } catch (err) {
        console.error('Error updating access code in Firestore:', err.message);
    }
}

// Load initial access code from Firestore
async function loadAccessCode() {
    if (!db) return;
    try {
        const doc = await db.collection('settings').doc('access_code').get();
        if (doc.exists) {
            currentAccessCode = doc.data().code;
            console.log(`Access code loaded from Firestore: ${currentAccessCode}`);
        }
    } catch (err) {
        console.error('Error loading access code from Firestore:', err.message);
    }
}

loadAccessCode();

io.on('connection', async (socket) => {
    console.log('A user connected:', socket.id);
    socket.authenticated = false;
    socket.role = null;

    // Authentication event
    socket.on('authenticate', (code) => {
        if (code === currentAccessCode) {
            socket.authenticated = true;
            socket.emit('authenticated', { success: true });
            console.log(`Socket ${socket.id} authenticated successfully.`);
            
            // Send initial data after authentication
            sendInitialData(socket);
        } else {
            socket.emit('authenticated', { success: false, message: 'Invalid access code.' });
            console.log(`Socket ${socket.id} failed authentication.`);
        }
    });

    // Register as Baby Monitor
    socket.on('register_as_baby', () => {
        if (!socket.authenticated) return;

        if (babySocketId && babySocketId !== socket.id) {
            console.log(`Registration REJECTED for ${socket.id}. Baby already connected: ${babySocketId}`);
            socket.emit('registration_failed', { message: 'Another user is already monitoring.' });
        } else {
            babySocketId = socket.id;
            socket.role = 'baby';
            console.log(`Socket ${socket.id} registered as BABY MONITOR.`);
            socket.emit('registration_success');
            // Notify others that a monitor is online
            io.emit('baby_status', { online: true });
        }
    });

    // Update Access Code
    socket.on('update_access_code', async (newCode) => {
        if (!socket.authenticated) return;
        
        console.log(`Updating access code to: ${newCode}`);
        currentAccessCode = newCode;
        await updateStoredAccessCode(newCode);
        
        // Broadcast to everyone that the code has changed (they might need to re-login if they refresh)
        io.emit('access_code_updated', { message: 'Access code has been changed by a parent.' });
    });

    // Receive audio chunk and broadcast
    socket.on('audio_chunk', (chunk) => {
        if (!socket.authenticated || socket.role !== 'baby') return;
        socket.broadcast.emit('audio_chunk', chunk);
    });

    async function sendInitialData(socket) {
        if (!socket.authenticated) return; // Ensure authenticated before sending data

        if (!db) {
            console.error('sendInitialData: Firestore is not initialized — skipping alert fetch.');
            socket.emit('initial_alerts', []);
            return;
        }

        // Send existing alerts from the last 24 hours to the newly connected mother dashboard
        const now = Date.now();
        const oneDayAgo = now - 86400000;

        try {
            const snapshot = await db.collection('alerts')
                .where('timestamp', '>=', oneDayAgo)
                .orderBy('timestamp', 'desc')
                .get();
            
            const alerts = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            socket.emit('initial_alerts', alerts);
        } catch (err) {
            console.error('Error fetching alerts:', err.message);
        }
    }

    // Receive an alert from the baby monitor (Requires Auth)
    socket.on('baby_alert', async (alertData) => {
        if (!socket.authenticated) {
            console.warn(`REJECTED: Unauthenticated baby_alert from socket ${socket.id}`);
            return;
        }
        console.log('Received alert:', alertData);

        if (!db) {
            console.error('baby_alert: Firestore is not initialized — alert will not be persisted.');
            socket.broadcast.emit('new_alert', alertData);
            return;
        }

        try {
            // Add to our database
            const docRef = await db.collection('alerts').add({
                type: alertData.type,
                date: alertData.date,
                time: alertData.time,
                timestamp: alertData.timestamp
            });
            alertData.id = docRef.id;
            // Broadcast to all connected mother dashboards
            socket.broadcast.emit('new_alert', alertData);
        } catch (err) {
            console.error('Error inserting alert:', err.message);
        }
    });

    // Receive an expression alert from the baby monitor and broadcast it (Requires Auth)
    socket.on('expression_alert', (expressionData) => {
        if (!socket.authenticated) {
            console.warn(`REJECTED: Unauthenticated expression_alert from socket ${socket.id}`);
            return;
        }
        console.log('Received expression alert:', expressionData);
        socket.broadcast.emit('new_expression', expressionData);
    });

    // Receive a video frame and broadcast it (Requires Auth)
    socket.on('video_frame', (frame) => {
        if (!socket.authenticated) {
            // Don't log every frame rejection to avoid spam, just once per socket if needed
            return;
        }
        socket.broadcast.emit('video_frame', frame);
    });

    // Delete all alert history from Firestore (Requires Auth)
    socket.on('delete_history', async () => {
        if (!socket.authenticated) {
            console.warn(`REJECTED: Unauthenticated delete_history from socket ${socket.id}`);
            socket.emit('delete_status', { success: false, message: 'Not authenticated' });
            return;
        }
        console.log(`--- DELETE HISTORY REQUEST [Socket: ${socket.id}] ---`);
        
        if (!db) {
            console.error('ERROR: Cannot delete. Firestore is NOT initialized (db is null).');
            socket.emit('delete_status', { success: false, message: 'Database not initialized' });
            return;
        }

        try {
            console.log('Fetching all documents from "alerts" collection...');
            const snapshot = await db.collection('alerts').get();
            console.log(`Query complete. Found ${snapshot.size} alerts in Firestore.`);

            if (snapshot.size > 0) {
                // Delete in chunks of 500 (Firestore limit)
                const chunks = [];
                for (let i = 0; i < snapshot.docs.length; i += 500) {
                    chunks.push(snapshot.docs.slice(i, i + 500));
                }

                console.log(`Planning deletion in ${chunks.length} batches...`);
                for (let i = 0; i < chunks.length; i++) {
                    const batch = db.batch();
                    chunks[i].forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    console.log(`Batch ${i+1}/${chunks.length} committed (${chunks[i].length} docs).`);
                }
                console.log(`SUCCESS: Deleted ${snapshot.size} alerts total.`);
            } else {
                console.log('INFO: Firestore already empty.');
            }
            // Broadcast to EVERYONE (including the sender)
            console.log('Broadcasting history_deleted to all clients...');
            io.emit('history_deleted');
            socket.emit('delete_status', { success: true });
        } catch (err) {
            console.error('ERROR during deletion operation:', err.message);
            socket.emit('delete_status', { success: false, message: err.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (socket.id === babySocketId) {
            console.log('BABY MONITOR disconnected.');
            babySocketId = null;
            io.emit('baby_status', { online: false });
        }
    });
});

// Clean up alerts older than 24 hours (86400000 ms) in the database
const CLEANUP_INTERVAL = 60 * 60 * 1000; // run every hour
setInterval(async () => {
    if (!db) {
        console.error('Cleanup interval: Firestore is not initialized — skipping cleanup.');
        return;
    }
    const oneDayAgo = Date.now() - 86400000;
    try {
        const snapshot = await db.collection('alerts')
            .where('timestamp', '<', oneDayAgo)
            .get();
        
        if (snapshot.size > 0) {
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`Cleaned up ${snapshot.size} old alerts`);
        }
    } catch (err) {
        console.error('Error deleting old alerts:', err.message);
    }
}, CLEANUP_INTERVAL);

let currentPort = process.env.PORT || 3000;

function startServer(port) {
    server.listen(port, () => {
        console.log(`\n================================================`);
        console.log(`  BABY MONITOR SERVER STARTED ON PORT: ${port}`);
        console.log(`  Access Monitor: http://localhost:${port}/baby.html`);
        console.log(`  Access Dashboard: http://localhost:${port}/mother.html`);
        console.log(`================================================\n`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} is busy, trying ${port + 1}...`);
            startServer(port + 1);
        } else {
            console.error('Server error:', err);
        }
    });
}

startServer(currentPort);