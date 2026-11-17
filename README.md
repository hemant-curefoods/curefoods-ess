# Curefoods ESS — Employee Self Service portal

Node.js (Express) + PostgreSQL. Serves the ESS web app and its API from one process, run by pm2 behind nginx.

**What employees get:** sign in with Employee ID + 4-digit PIN (first time: verify date of birth, then set a PIN) · My Profile · Offer Letter · Payslips (NAPS) · Helpdesk tickets with attachments.
**What HR gets:** pending/closed ticket queues with a 48h SLA, remarks, reassignment, closing · PIN reset.
**Admins:** read-only "View as Employee" (30 min, reason required, audited).

```
public/            the web app (HTML/CSS/JS, unchanged look from the prototype)
src/server.js      Express server, security headers, rate limits
src/api/           account (sign-in, PINs, view-as) · tickets · documents · ingest (signed pushes from PortalSync)
bridge/            PortalSync.gs — Apps Script that copies offer letters + payslips into the portal
src/employees.js   Employee Master mapping, role rules, ticket routing
sql/               000 = DB user setup (run once as admin) · 001 = schema "ess"
scripts/           migrate · import-employees (Excel/CSV) · make-template
deploy/            nginx config
test/              API + unit tests
```

## How it works

| Topic | Rule |
|---|---|
| Data location | Everything lives in its own **`ess` schema**. The app logs in as `ess_app`, which can only touch that schema. |
| PINs | Peppered HMAC + bcrypt. 5 wrong PIN/DOB tries → ID locked 30 min; 30 failed sign-in steps from one IP → that IP blocked for an hour (stops trying one PIN across many IDs). Weak PINs (1111, 1234, birth year/day) refused. Only HR can reset; reset signs the employee out everywhere. |
| Sessions | Random token, stored hashed. 60 min idle / 12 h max. View-as sessions: 30 min, read-only (enforced on the server). |
| Roles | From the Employee Master on every request: **HR Head** = `HR_HEAD_CODES`; **HR** = appears as someone's *HR Manager Code*; **L1** = appears as someone's *L1 Manager Code*; **Admin** flag = `ADMIN_CODES`. |
| Ticket routing | POSH → HR Head. Otherwise → the employee's *HR Manager Code* (if that person is active HR), else HR Head. |
| Who sees a ticket | Raiser · assigned HR · HR who acted on it · HR Head (all). Attachments follow the same rule. |
| Privacy | The browser never receives the Employee Master or anyone's full mobile number. Bank/PAN/Aadhaar columns in the HR export are **not imported**. |
| Audit | `ess.audit_log`: sign-ins, failed tries, lockouts, PIN set/change/reset, view-as start/end, document opens, imports. |

---

## Deploy on the server (pm2 + nginx)

Run as root unless noted. Replace `<dbname>` with the real Postgres database name (`psql -U admin -d postgres -c '\l'`).

### 1. Prerequisites
```bash
node -v          # needs 18+;  if missing: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
npm i -g pm2
nginx -v || apt-get install -y nginx
```

### 2. App user + code
```bash
adduser --disabled-password --gecos "" ess
mkdir -p /opt/curefoods-ess /var/lib/curefoods-ess/uploads /var/lib/curefoods-ess/documents /var/log/curefoods-ess
git clone <REPO_URL> /opt/curefoods-ess
chown -R ess:ess /opt/curefoods-ess /var/lib/curefoods-ess /var/log/curefoods-ess
chmod 750 /var/lib/curefoods-ess/uploads /var/lib/curefoods-ess/documents
cd /opt/curefoods-ess && sudo -u ess npm ci --omit=dev
```

### 3. Database user + schema
```bash
# strong password for the app's DB login
APP_PW=$(openssl rand -base64 24 | tr -d '/+=' ); echo "$APP_PW"   # copy it for .env
psql -h localhost -U admin -d <dbname> -v app_password="'$APP_PW'" -f sql/000_setup_db_user.sql
```

### 4. Configure
```bash
sudo -u ess cp .env.example .env && chmod 600 .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # -> PIN_PEPPER
sudo -u ess nano .env
```
Fill in: `PGDATABASE=<dbname>`, `PGPASSWORD=<APP_PW>`, `PIN_PEPPER`, `HR_HEAD_CODES`, `ADMIN_CODES`, `INGEST_SECRET` (step 8).
Back up `.env` somewhere safe — losing `PIN_PEPPER` means every employee must re-set their PIN.

```bash
sudo -u ess npm run migrate
```

### 5. Load the Employee Master
Copy the HR export ("Employee Report New …xlsx") to the server, then:
```bash
sudo -u ess npm run import:employees -- /tmp/Employee_Report.xlsx --sheet Report            # dry run: check counts + warnings
sudo -u ess npm run import:employees -- /tmp/Employee_Report.xlsx --sheet Report --apply
shred -u /tmp/Employee_Report.xlsx     # the export contains PAN/Aadhaar/bank data — don't leave it lying around
```
Re-run the same command whenever HR sends a fresh export (upsert by Employee Code; PINs and tickets are kept).
Add `--mark-missing-exited` to mark active employees who are no longer in the file as *Exited*.
Template with the expected headers: `templates/employee_master_template.xlsx`.

### 6. Start with pm2
```bash
sudo -u ess pm2 start ecosystem.config.js
sudo -u ess pm2 save
pm2 startup systemd -u ess --hp /home/ess      # run the command it prints, so the app survives reboots
curl -s http://127.0.0.1:3100/healthz           # -> {"ok":true}
```

### 7. nginx (IP-only pilot on port 8080)
```bash
cp deploy/nginx-ess.conf /etc/nginx/sites-available/curefoods-ess
ln -s /etc/nginx/sites-available/curefoods-ess /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
ufw allow from <OFFICE_IP> to any port 8080 proto tcp     # pilot: only your office/VPN IPs
```
Open `http://103.172.150.31:8080`.

> ⚠️ **Plain HTTP sends PINs unencrypted.** Use the IP-only setup for a small internal pilot only. Before employees use it, point a domain at the server and add HTTPS (step 9).

### 8. Offer letters + payslips (PortalSync)
Your existing Apps Scripts keep generating letters and payslips exactly as today. A small extra script,
**`bridge/PortalSync.gs`**, copies them into the portal every 15 minutes:

```
Offer Letter tool ──► "Offer Log" tab (Status = Sent, Offer URL)        ┐
NAPS payslip tool ──► each entity's "Payroll" tab (Status = Generated,  ├─► PortalSync.gs ──(signed HTTPS)──► /ingest ──► ess.offer_letters / ess.payslips + PDFs on disk
                      PDF File ID)                                       ┘
```
- It asks the portal what it already has and sends only **new or regenerated** documents. The first runs back-fill history (a few hundred per run).
- It **never edits** your sheets. It needs only *view* access to the sheets and the PDF folders.
- Requests are signed with HMAC-SHA256 + a timestamp (`INGEST_SECRET`). Unsigned, stale or tampered requests are rejected; only real PDFs are accepted.
- Employees then open documents straight from the portal, with no Google calls at view time (fast on payday, not tied to Google quotas).

> Needs the **domain + HTTPS** (step 9) first: payslips carry salary data, and Google must be able to reach `https://<domain>/ingest`. The script refuses `http://` URLs.

**Portal side**
```bash
node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"   # -> INGEST_SECRET
mkdir -p /var/lib/curefoods-ess/documents && chown ess:ess /var/lib/curefoods-ess/documents && chmod 750 /var/lib/curefoods-ess/documents
# .env:  DOCS_SOURCE=db   DOCS_DIR=/var/lib/curefoods-ess/documents   INGEST_SECRET=<value>
sudo -u ess pm2 reload curefoods-ess
```

**Google side** (≈10 min, from an HR/ops Google account — ideally a shared one, not a personal one — that can open the Offer Letter spreadsheet, every entity's Payroll spreadsheet and the PDF folders)
1. Go to script.google.com → **New project**, name it *ESS PortalSync*, and paste in `bridge/PortalSync.gs`.
2. Open **Project Settings → Script Properties** and add:

   | Property | Value |
   |---|---|
   | `PORTAL_URL` | `https://ess.curefoods.in` |
   | `PORTAL_SECRET` | same value as `INGEST_SECRET` |
   | `OFFER_SHEET_ID` | id from the Offer Letter spreadsheet URL (`/d/<id>/edit`) |
   | `NAPS_SHEET_IDS` | the Payroll spreadsheet ids, comma-separated (one per entity) |
3. Run **`testPortalConnection`** and approve the permissions. The log should show the portal's counts and each sheet's row count.
4. Run **`setupPortalSync`**. It starts the first sync now and schedules one every 15 minutes.
5. Check progress: Script Properties → `LAST_SYNC` (e.g. `offers+212 payslips+340 pending 1200 (next run)`).

Notes
- **Regenerated payslip** (re-run after a correction): the new PDF replaces the old one in the portal at the next sync.
- **Letter issued in error:** in the script editor run `removeFromPortal('offer', '<Drive file id>')` (or `'payslip'`).
- **Matching:** an offer shows for an employee when its *Phone Number* matches their mobile in the Employee Master **and** its *Date of Birth* matches (unless the offer's DOB is blank or a placeholder). Payslips match on *Employee ID*.
- **Column renamed in a sheet?** Update the `COLS` block at the top of `PortalSync.gs`.

**Alternative: read live from Google with a service account.** Set `DOCS_SOURCE=google`, create a service account (Google Cloud Console → enable the Sheets and Drive APIs → service account → JSON key), share the sheets and PDF folders with its e-mail as Viewer, then set `GOOGLE_APPLICATION_CREDENTIALS`, `OFFER_SHEET_ID` and `NAPS_SHEET_IDS`.

### 9. Domain + HTTPS (later)
```bash
# DNS: A record  ess.curefoods.in -> 103.172.150.31
# in /etc/nginx/sites-available/curefoods-ess:  listen 80;  server_name ess.curefoods.in;
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d ess.curefoods.in
# .env:  HTTPS=true   then:  sudo -u ess pm2 reload curefoods-ess
```

---

## Day-to-day

| Task | Command |
|---|---|
| Update code | `cd /opt/curefoods-ess && sudo -u ess git pull && sudo -u ess npm ci --omit=dev && sudo -u ess npm run migrate && sudo -u ess pm2 reload curefoods-ess` |
| Logs | `sudo -u ess pm2 logs curefoods-ess` |
| Refresh Employee Master | step 5 |
| Backup | `pg_dump -h localhost -U admin -d <dbname> -n ess -Fc > ess_$(date +%F).dump` + copy `/var/lib/curefoods-ess/uploads` (documents can be re-synced from Google) |
| Who reset whose PIN? | `SELECT * FROM ess.audit_log WHERE action='pin_reset' ORDER BY at DESC;` |

## Server hardening checklist
- [ ] PostgreSQL port **5432 is reachable from the internet** today. The app connects via `localhost`, so restrict it: `ufw deny 5432` (allow only the Metabase server's IP if Metabase is elsewhere), or set `listen_addresses='localhost'`.
- [ ] Don't run the app as root (step 2 creates the `ess` user).
- [ ] SSH: key-only login (`PasswordAuthentication no`), fail2ban on.
- [ ] Domain + HTTPS before company-wide rollout.

## Local development
```bash
cp .env.example .env     # point at a local Postgres
npm install && npm run migrate
npm run import:employees -- templates/employee_master_template.xlsx --apply
npm run dev              # http://127.0.0.1:3100
npm test                 # needs the server running (AUTH_FAIL_LIMIT=1000) + the prototype's sample employees;
                         # set INGEST_SECRET in the shell to include the PortalSync simulation
```
