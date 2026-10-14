# Deploying to a cPanel / WHM server (e.g. a 123-reg dedicated server)

This puts the app at **https://enquiries.raresquarelabs.co.uk**, running alongside your existing cPanel sites without disturbing them.

How it fits together:
- **cPanel** creates the subdomain and its free SSL certificate (AutoSSL), as for any site.
- **The app** runs in the background as a system service on the server, on a private port (3000).
- **Apache** (cPanel's web server) passes the subdomain's traffic to the app.

> **No WHM/Terminal, just cPanel?** Use [DEPLOY-CPANEL-NODEJS-APP.md](DEPLOY-CPANEL-NODEJS-APP.md) instead.

You need **root SSH access** (the same login as WHM). Commands below are run as root: `ssh root@YOUR-SERVER-IP`.

> **Why not cPanel's "Setup Node.js App"?** It puts idle apps to sleep. This app has to stay awake to check inboxes and send follow-ups on time, so it runs as its own service instead.

---

## 1. Create the subdomain (cPanel)

1. Log in to **cPanel** for the account that owns `raresquarelabs.co.uk`.
2. Go to **Domains → Create A New Domain**. Enter `enquiries.raresquarelabs.co.uk`, untick "Share document root" if it's shown, and click **Submit**.
3. Note the **cPanel username** (top right of cPanel). You'll need it in step 6.

**DNS:** where is the domain's DNS managed?
- If the domain uses **your server's nameservers**, cPanel has already created the DNS record. Nothing more to do.
- If it uses **123-reg's nameservers** (the usual case when the domain was bought at 123-reg), go to 123-reg → Domains → `raresquarelabs.co.uk` → **Manage DNS** and add an **A** record: hostname `enquiries`, value **your server's IP**.

To check, run `nslookup enquiries.raresquarelabs.co.uk` on any computer. It should show your server's IP.

## 2. SSL certificate

In cPanel → **Security → SSL/TLS Status**, tick `enquiries.raresquarelabs.co.uk` and click **Run AutoSSL**. (It also runs by itself within a few hours.) Then in **Domains**, switch on **Force HTTPS Redirect** for the subdomain.

## 3. Install Node.js 22

cPanel servers run AlmaLinux, CloudLinux or Rocky Linux:

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs git sqlite
node --version     # must say v22.5 or newer
```

## 4. Get the app onto the server

```bash
useradd --system --create-home --home-dir /opt/enquiries-home --shell /sbin/nologin enquiries
mkdir -p /opt/enquiries /var/lib/enquiries
chown enquiries: /opt/enquiries /var/lib/enquiries
chmod 700 /var/lib/enquiries

sudo -u enquiries git clone -b claude/dreamy-bardeen-uw3ho7 \
  https://github.com/ijohndurkin-blip/rare-email-enquiry.git /opt/enquiries
cd /opt/enquiries
sudo -u enquiries npm ci --omit=dev
```

> **Private repo?** When asked, enter your GitHub username, and as the password a **fine-grained personal access token** with read access to this repo (GitHub → Settings → Developer settings → Personal access tokens).

## 5. Settings, then start it

```bash
cp /opt/enquiries/deploy/enquiries.env.example /etc/enquiries.env
openssl rand -hex 32          # copy this output for APP_SECRET
nano /etc/enquiries.env       # set ADMIN_PASSWORD and paste APP_SECRET
chmod 600 /etc/enquiries.env

cp /opt/enquiries/deploy/enquiries.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now enquiries
systemctl status enquiries                 # should say "active (running)"
curl -s localhost:3000/login | head -3     # should print some HTML
```

**Keep `APP_SECRET` somewhere safe** (a password manager). It encrypts the stored mailbox passwords and the AI key.

## 6. Connect the subdomain to the app (Apache)

Replace `CPANELUSER` with the cPanel username from step 1:

```bash
U=CPANELUSER
D=enquiries.raresquarelabs.co.uk
for t in ssl std; do
  mkdir -p /etc/apache2/conf.d/userdata/$t/2_4/$U/$D
  cp /opt/enquiries/deploy/apache-proxy.conf /etc/apache2/conf.d/userdata/$t/2_4/$U/$D/proxy.conf
done
httpd -M 2>/dev/null | grep -E 'proxy_module|proxy_http'   # both should be listed
/scripts/rebuildhttpdconf && /scripts/restartsrv_httpd
```

If `proxy_http` isn't listed, install it with `dnf install -y ea-apache24-mod_proxy_http` (or WHM → **EasyApache 4** → Customize → Apache Modules → `mod_proxy_http`), then run the last line again.

## 7. Let the app send email ⚠️ important

cPanel servers often block programs from sending email directly to other mail servers, as an anti-spam measure. The app sends replies through each business's own mailbox (ports 465 and 587), so it needs an exception.

**If the server has CSF firewall** (WHM → Plugins → **ConfigServer Security & Firewall**):
1. Open **Firewall Configuration**.
2. Find `SMTP_ALLOWUSER` and set it to `enquiries`.
3. Make sure `TCP_OUT` includes `993`, `465` and `587` (add any that are missing, comma separated).
4. Click **Change**, then **Restart csf+lfd**.

**If there's no CSF:** in WHM → **Security Center → SMTP Restrictions**, check the status. If it's enabled, disable it. (Or install CSF and use the allow-list above, which is the tidier option.)

To test from the server:

```bash
sudo -u enquiries -s /bin/bash -c 'timeout 8 openssl s_client -connect smtp.gmail.com:465 -quiet </dev/null 2>&1 | head -2'
```

It should print a `220 smtp.gmail.com` greeting. If it hangs or is refused, sending is still being blocked.

## 8. Open it

Go to **https://enquiries.raresquarelabs.co.uk/admin**, sign in with your `ADMIN_PASSWORD`, add your AI key under **✨ Set up AI**, and create your first business.

---

## Updating to a new version

```bash
/opt/enquiries/deploy/update.sh
```

## Backups

Everything is in `/var/lib/enquiries`. For a nightly copy that keeps 14 days, run `crontab -e` and add:

```
30 2 * * * sqlite3 /var/lib/enquiries/enquiries.db ".backup '/root/enquiry-backups/enquiries-$(date +\%F).db'" && find /root/enquiry-backups -mtime +14 -delete
```

(Create the folder first: `mkdir -p /root/enquiry-backups`.) You can also add `/var/lib/enquiries` and `/root/enquiry-backups` to WHM → **Backup Configuration → Additional Destinations / files**.

## Troubleshooting

| Problem | Check |
|---|---|
| Subdomain shows the cPanel default page | Step 6 not applied: check the file paths use the right cPanel username, re-run `/scripts/rebuildhttpdconf && /scripts/restartsrv_httpd` |
| "503 Service Unavailable" | The app isn't running: `systemctl status enquiries`, `journalctl -u enquiries -n 50` |
| Certificate warning | Run AutoSSL again (step 2). DNS must point at the server first |
| Mailbox connects but replies won't send | Step 7: outgoing email is blocked for the `enquiries` user |
| Can't connect a mailbox at all | `TCP_OUT` in CSF must include `993`; for Gmail use an app password |
| Alert email links go to the wrong address | Set `APP_URL` in `/etc/enquiries.env`, then `systemctl restart enquiries` |
