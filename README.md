# Reading Room Manager (45 Seats)

A complete local web app for your reading room/library business:

- Track enrollments and active students
- Track payments (Rs 1200 / Rs 3000 plans or custom)
- Visual 45-seat layout (occupied/vacant)
- Vacate seats in one click
- Import students from Google Form response sheet
- Receipt approval queue with WhatsApp send/skip flow

## 1) Run

Requirements: Node.js 20+.

```bash
npm start
```

Open: `http://localhost:3000`

For same-WiFi device access (phone/laptop):

```bash
ipconfig getifaddr en0
PORT=3000 npm start
```

Then open `http://<your-local-ip>:3000` on other devices.

## 2) Google Form Integration

Your Google Form stores responses in a Google Sheet. Use the **Sheet URL** (or CSV URL) in the app's import box.

- If you paste a normal Google Sheet URL, app auto-converts it to CSV fetch URL.
- Make sure sheet is publicly readable for import.

Recommended Google Sheet columns (exact names not mandatory, these are auto-detected):

- `Full Name`
- `Phone Number`
- `Seat` (optional)
- `Course` (optional)
- `Amount` (optional)
- `Plan` (optional: contains `1` or `3`)
- `Timestamp` or `Payment Date` (optional)
- `Transaction ID` / `UTR` (optional)

## 3) WhatsApp Receipt Flow

After every enrollment/import, a receipt item is added to **Pending WhatsApp Receipts**.

- Click **Send Receipt** to send.
- If WhatsApp Cloud API env vars are missing, app opens a `wa.me` message link.
- Click **Skip** if you do not want to send.

Optional auto-send via WhatsApp Cloud API:

```bash
export WHATSAPP_CLOUD_TOKEN=...
export WHATSAPP_PHONE_NUMBER_ID=...
npm start
```

## 4) Data Storage

All data is stored in:

- `data/store.json`

No external database is required for this MVP.

## 5) Deploy (Public URL, all devices)

### Option A: Render (recommended)

1. Push this project to GitHub.
2. In Render, create a new Web Service from your repo.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Set environment variables:
   - `GOOGLE_SHEET_URL`
   - Optional: `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
   - Optional: `PUBLIC_BASE_URL`, `RECEIPT_PDF_URL`
5. Use generated app URL on any device.

You can also use the included [render.yaml](/Users/abrarmir/Documents/New project/render.yaml) as Blueprint.

### Option B: Docker (any VPS/provider)

```bash
docker build -t learning-dock .
docker run -p 3000:3000 --env-file .env learning-dock
```

Use provided [Dockerfile](/Users/abrarmir/Documents/New project/Dockerfile).

## 6) Production Data Safety (important)

This app currently uses file storage (`data/store.json`).

- Local machine: data is persistent.
- Cloud deployment: file storage may reset on redeploy/restart unless persistent disk is configured.

Minimum safe practice:
- Keep regular backups of `data/store.json`.
- Keep one copy in cloud drive.

If you want, next step is migrating to MongoDB/Postgres for fully reliable persistence.
