# WasteWatch — Industrial IoT Smart Waste Platform v3.0

Professional local industrial dashboard for the two-node Smart Waste Bin System (B1 sensor ↔ LoRa 433 MHz ↔ B2 gateway, Arduino Mega 2560).

**Industrial Theme:** Precision Industrial Dark (Black, Blue, White)  
**Map Engine:** Google Maps Dual-Node Live Tracking (B1 Sensor + B2 Gateway on single map)

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Dashboard layout (pure semantic HTML5) |
| `styles.css`  | Industrial dark black/blue/white responsive styling |
| `app.js`      | Web Serial parser, Google Maps engine, SVG charts, alerts, CSV export |
| `run_dashboard.bat` | One-click launcher for Chrome / Edge |

No npm, no build step, no framework required.

---

## How to Run

### Option A – VS Code Live Server (Recommended)
1. Open the `smart_waste_dashboard` folder in VS Code.
2. Right-click `index.html` → **Open with Live Server**.
3. The browser opens at `http://127.0.0.1:5500/`.
4. Click **Connect B2 USB** and select the B2 Arduino COM port, or click **✦ Try demo** to test with simulated data.

### Option B – Terminal HTTP Server
```powershell
python -m http.server 8080
```
Open `http://localhost:8080` in Chrome or Edge.

### Option C – run_dashboard.bat
Double-click `run_dashboard.bat`.

> ⚠️ **Note:** The Web Serial API only works in **Chrome or Edge** when served via `http://localhost` or `http://127.0.0.1` (NOT via `file://`).

---

## How Telemetry Reaches the Dashboard

Only **B2 (Gateway)** needs to be connected to the computer by USB.
B1 reads all sensors (MQ-2, DHT22, HC-SR04, GPS) and transmits to B2 via LoRa SX1278 (433.92 MHz SF9). B2 receives the packet, replies with an ACK containing its own GPS coordinates, and prints telemetry over USB serial at 9600 baud.

### Expected Serial Format (9600 baud)
```text
B1,SEQ:5,GAS:127,DOUT:1,GAS_ALERT:INACTIVE,TEMP_ALERT:NORMAL,HUM_ALERT:NORMAL,DIST:45.2,FILL:62,FILL_ALERT:NORMAL,STATUS:ONLINE,TEMP:31.4,HUM:68.2,LAT:12.852101,LON:80.226501,GPS_FIX:FIX,SATS:7,ALERT:NORMAL,B2_LAT:12.852250,B2_LON:80.226620,B2_GPS_FIX:FIX,B2_SATS:6
RSSI:-72 dBm
SNR:8.25 dB
ACK_TX: SUCCESS
-------------------------
```

---

## Dashboard Capabilities

- **Single Google Map with Dual Live Tracking**: Plots both B1 (Sensor Node) in Precision Blue and B2 (Gateway Node) in Electric Cyan, draws a dashed LoRa link line with distance in meters/km, and automatically fits bounds to show both nodes.
- **6 Industrial KPI Cards**: Fill Level gauge (Blue/Amber/Red), Temperature (°C), Humidity (% RH), MQ-2 Gas sensor (ADC counts & DOUT state), Ultrasonic distance (cm), and LoRa RF quality (RSSI dBm & SNR dB).
- **Network Health Matrix**: Interactive diagram showing B1 and B2 connectivity, animated packet transmissions, ACK status, and sensor alerts.
- **Sensor Trend Charts**: SVG telemetry history with user-configurable warning/critical threshold lines.
- **Alert Dispatch Engine**: Categorized alerts (Critical, Warning, Info) with timestamped event logging.
- **Data Log & CSV Export**: Export historical records to standard CSV for spreadsheet analysis.
- **Developer Serial Terminal**: Real-time stream monitor with level filtering (`[SYS]`, `[DATA]`, `[WARN]`, `[ERR]`), line count, and one-click clipboard copy.
- **Demo Mode**: Built-in realistic simulation of full bin lifecycle with live GPS, fill level changes, and sensor alarms.
