const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

async function testKey(keyPath) {
    console.log(`\nTesting key: ${keyPath}`);
    if (!fs.existsSync(keyPath)) {
        console.log(`EROR: File not found at ${keyPath}`);
        return;
    }

    try {
        const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        
        // Use a unique app name for each test to avoid conflicts
        const appName = `app-${Date.now()}`;
        const app = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        }, appName);

        const db = app.firestore();
        console.log(`Connecting to project: ${serviceAccount.project_id}...`);
        
        // Simple write/read test
        await db.collection('config').doc('health_check_test').set({
            last_test: new Date().toISOString(),
            test_key_id: serviceAccount.private_key_id
        });
        
        console.log(`SUCCESS: Key ${serviceAccount.private_key_id} is ACTIVE and working.`);
        await app.delete();
    } catch (err) {
        console.log(`FAILURE: Key at ${keyPath} failed. Error: ${err.message}`);
    }
}

async function runTests() {
    await testKey('c:/Users/ELCOT/OneDrive/Desktop/baby/firebase-service-account.json');
    await testKey('c:/Users/ELCOT/OneDrive/Desktop/baby/smart-baby-monitor/firebase-service-account.json');
    process.exit();
}

runTests();
