# Apex Gold Signals – deploy on Render
1. Free API key at twelvedata.com.
2. Install the ntfy app, subscribe to a long random topic (e.g. apex-gold-7f3k9q2x).
3. Push this folder to GitHub. Render > New > Web Service. Build: `npm install`  Start: `npm start`
4. Environment: TWELVEDATA_KEY = your key, NTFY_TOPIC = your topic.
5. Open https://YOUR-APP.onrender.com/api/test to receive a test notification.
6. Free Render services sleep after 15 min idle. Ping /health every 5 min (e.g. UptimeRobot) or use a paid instance so alerts keep running.
