# Smart Baby Monitor (Static Version)

A real-time baby monitoring dashboard designed for web browsers.

## 🚀 How to Use

This version is optimized for **direct file opening** or **Cloud Hosting (Render)**.

1. **Direct Opening**: Simply open `index.html` in any modern web browser.
2. **Cloud Hosting (Render)**:
   - Push this repository to GitHub.
   - Log in to [Render](https://render.com).
   - Click **New +** > **Blueprint**.
   - Connect your GitHub repository.
   - Render will automatically detect `render.yaml` and set up the service.
   - **Crucial**: Go to the **Environment** tab in Render and add the `FIREBASE_SERVICE_ACCOUNT` variable.

## 📂 Project Structure

- `index.html`: Main landing page.
- `baby.html`: The monitoring page (requires camera/mic permissions).
- `mother.html`: The dashboard to view alerts and live feed.
- `assets/`: Images and icons.
- `css/`: Styling for the application.
- `js/`: Application logic.

## ⚠️ Important Note
Since this is a static version hosted on GitHub Pages:
- **Alert History** is local to your session (not saved to a database).
- **Socket.io** real-time syncing between different devices requires a running backend server (included in `server.js` but not used for static hosting).

## ⚙️ Configuration
To run with a database (Firestore), you need to provide your Firebase Service Account credentials.
- **Local**: Place `firebase-service-account.json` in the root folder.
- **Production**: Set the `FIREBASE_SERVICE_ACCOUNT` environment variable with the full JSON content of your service account key.

---
Developed for peace of mind.
