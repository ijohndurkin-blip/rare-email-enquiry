# Deploying to an Ubuntu/Debian or Plesk server

> **Server has cPanel/WHM?** Use [DEPLOY-CPANEL.md](DEPLOY-CPANEL.md) instead.

This puts the app at **https://enquiries.raresquaredlabs.co.uk**. (You can use any name you like instead of `enquiries`. If you do, change it everywhere below and in `nginx-enquiries.conf`.)

The steps assume **Ubuntu or Debian** with SSH root access. If your server runs **Plesk**, see the note at the end. Commands go in an SSH session on the server (`ssh root@YOUR-SERVER-IP`).

---

## 1. Point the subdomain at the server (123-reg control panel)

1. Log in to 123-reg → **Domains** → `raresquaredlabs.co.uk` → **Manage DNS** (Advanced DNS).
2. Add a record:
   - **Type:** `A`
   - **Hostname:** `enquiries`
   - **Destination / Value:** your server's IP address (shown in the 123-reg server panel)
   - **TTL:** default
3. Save. It usually works within minutes but can take up to a few hours. To check, run this on any computer:
   ```bash
   nslookup enquiries.raresquaredlabs.co.uk
   ```
   It should show your server's IP.

> If the domain's nameservers point somewhere else (e.g. Cloudflare), add the A record there instead.

## 2. Install Node.js 22, nginx and HTTPS tools

```bash
apt-get update
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git nginx certbot python3-certbot-nginx sqlite3
node --version   # should say v22.something
```

## 3. Get the app onto the server

```bash
useradd --system --create-home --shell /usr/sbin/nologin enquiries
mkdir -p /opt/enquiries /var/lib/enquiries
chown enquiries: /opt/enquiries /var/lib/enquiries
chmod 700 /var/lib/enquiries

sudo -u enquiries git clone -b claude/dreamy-bardeen-uw3ho7 \
  https://github.com/ijohndurkin-blip/rare-email-enquiry.git /opt/enquiries
cd /opt/enquiries
sudo -u enquiries npm ci --omit=dev
```

> **Private repo?** GitHub will ask for a username and password. Use your GitHub username, and for the password a **fine-grained personal access token** with read-only access to this repo (GitHub → Settings → Developer settings → Personal access tokens).

## 4. Settings

```bash
cp /opt/enquiries/deploy/enquiries.env.example /etc/enquiries.env
openssl rand -hex 32          # copy this output for APP_SECRET
nano /etc/enquiries.env       # set ADMIN_PASSWORD and paste APP_SECRET
chmod 600 /etc/enquiries.env
```

**Keep a copy of `APP_SECRET` somewhere safe** (a password manager). It encrypts the stored mailbox passwords and the AI key.

## 5. Start the app (and keep it running)

```bash
cp /opt/enquiries/deploy/enquiries.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now enquiries
systemctl status enquiries          # should say "active (running)"
curl -s localhost:3000/login | head -3   # should print some HTML
```

The service starts on boot and restarts itself if it ever stops. To watch the logs: `journalctl -u enquiries -f`.

## 6. Put it on the subdomain with HTTPS

```bash
cp /opt/enquiries/deploy/nginx-enquiries.conf /etc/nginx/sites-available/enquiries
ln -s /etc/nginx/sites-available/enquiries /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d enquiries.raresquaredlabs.co.uk   # free certificate, renews automatically
```

If a firewall is on (`ufw status`), allow the web through it with `ufw allow 'Nginx Full'`. Leave port 3000 closed: the app only listens privately, behind nginx.

The app also needs to make **outgoing** connections to mail servers (ports 993, 465 and 587) and to websites and the AI service (port 443). These are open on 123-reg servers by default.

## 7. Open it

Go to **https://enquiries.raresquaredlabs.co.uk/admin**, sign in with your `ADMIN_PASSWORD`, add your AI key under **✨ Set up AI**, and create your first business.

---

## Updating to a new version

```bash
/opt/enquiries/deploy/update.sh
```

## Backups

Everything lives in `/var/lib/enquiries` (the database plus `secret.key`, if you didn't set `APP_SECRET`). A nightly backup that keeps 14 days:

```bash
mkdir -p /root/enquiry-backups
crontab -e
# add this line:
30 2 * * * sqlite3 /var/lib/enquiries/enquiries.db ".backup '/root/enquiry-backups/enquiries-$(date +\%F).db'" && find /root/enquiry-backups -mtime +14 -delete
```

Copy that folder off the server now and then (or use 123-reg's backup service).

## If your server has Plesk

Plesk manages nginx itself, so skip step 6 and do this instead:

1. Do steps 2–5 above (in step 2, leave out `nginx certbot python3-certbot-nginx`).
2. In Plesk, go to **Websites & Domains → Add Subdomain** and add `enquiries` under `raresquaredlabs.co.uk`.
3. On the subdomain, open **SSL/TLS Certificates → Let's Encrypt** and issue a certificate (tick "redirect HTTP to HTTPS").
4. On the subdomain, open **Apache & nginx Settings**:
   - untick **Proxy mode**
   - in **Additional nginx directives**, paste:
     ```
     location / {
         proxy_pass http://127.0.0.1:3000;
         proxy_http_version 1.1;
         proxy_set_header Host $host;
         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
         proxy_set_header X-Forwarded-Proto $scheme;
         proxy_read_timeout 180s;
     }
     ```
   - Click **OK**.

Don't use Plesk's own "Node.js" app feature for this. It can put idle apps to sleep, which would stop inbox checks and follow-ups.

## Troubleshooting

| Problem | Check |
|---|---|
| Subdomain doesn't load | `nslookup enquiries.raresquaredlabs.co.uk` shows the server IP? `systemctl status nginx` |
| "502 Bad Gateway" | The app isn't running: `systemctl status enquiries`, `journalctl -u enquiries -n 50` |
| Can't connect a mailbox | Try the connect screen again; for Gmail use an app password. From the server: `openssl s_client -connect imap.gmail.com:993` should connect |
| Alert email links point to the wrong address | Set `APP_URL` in `/etc/enquiries.env`, then `systemctl restart enquiries` |
