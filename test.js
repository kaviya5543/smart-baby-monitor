const fs = require('fs');
const log = (msg) => {
    fs.appendFileSync('debug.log', msg + '\n');
    console.log(msg);
};

try {
    log('Starting test...');
    const express = require('express');
    log('express loaded');
    const http = require('http');
    log('http loaded');
    const { Server } = require('socket.io');
    log('socket.io loaded');
    const path = require('path');
    log('path loaded');
    const admin = require('firebase-admin');
    log('firebase-admin loaded');

    // Check for service account file
    if (fs.existsSync('./firebase-service-account.json')) {
        log('firebase-service-account.json found');
        const serviceAccount = require('./firebase-service-account.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        log('Firebase initialized');
        const db = admin.firestore();
        log('Firestore instance linked');
    } else {
        log('WARNING: firebase-service-account.json NOT found. Firebase will not initialize.');
    }

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    log('App and Server initialized');

    const PORT = 3000;
    server.on('error', (e) => {
        log('SERVER ERROR: ' + e.message);
        if (e.code === 'EADDRINUSE') {
            log('Port ' + PORT + ' is already in use');
        }
        process.exit(1);
    });

    server.listen(PORT, () => {
        log('Server successfully started on port ' + PORT);
        process.exit(0);
    });
} catch (e) {
    log('ERROR: ' + e.message);
    log(e.stack);
    process.exit(1);
}
