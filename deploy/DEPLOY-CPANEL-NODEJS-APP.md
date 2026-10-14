# Deploying with cPanel "Setup Node.js App" (no command line needed)

This is for cPanel accounts **without** root, WHM or Terminal access: the usual set-up when one server hosts several domains, each with its own cPanel. Everything is done by clicking in cPanel.

It puts the app at **https://enquiries.raresquaredlabs.co.uk**.

How it works:
- **Setup Node.js App** runs the app and connects it to the subdomain.
- This kind of hosting puts apps to sleep when nobody is using them. A **cron job** therefore opens a private wake-up link every 5 minutes, which checks inboxes and sends any follow-ups that are due.
- The data lives in a folder outside the app, so updating the app never touches it.

In the paths below, `d3wl4ur63d24` is your cPanel username, shown at the top right of cPanel. Change it if yours is different.

---

## 1. Subdomain and SSL

1. **Domains → Create A New Domain:** `enquiries.raresquaredlabs.co.uk` (you've done this already ✓).
2. At 123-reg, `raresquaredlabs.co.uk` → **Manage DNS** should have an **A** record `enquiries` pointing at this server's IP (shown as "Shared IP Address" on the cPanel home page).
3. **SSL/TLS Status:** tick the subdomain and click **Run AutoSSL**.

## 2. Make three secret values

Use a password manager or any password generator to create three long random values (letters and numbers only, **at least 32 characters**). Save them in your password manager:

- **ADMIN_PASSWORD**: what you'll log in to `/admin` with
- **APP_SECRET**: encrypts stored mailbox passwords and the AI key. **Never lose or change this.**
- **CRON_KEY**: the secret part of the wake-up link

## 3. Upload the app

1. Download the app as a zip. While logged in to GitHub, open:
   `https://github.com/ijohndurkin-blip/rare-email-enquiry/archive/refs/heads/claude/dreamy-bardeen-uw3ho7.zip`
2. In cPanel, open **File Manager**. You'll start in your home folder (`/home/d3wl4ur63d24`). Stay there; **don't** go into `public_html`.
3. Click **Upload** and upload the zip. Go back, right-click the zip and choose **Extract**.
4. A folder called `rare-email-enquiry-claude-dreamy-bardeen-uw3ho7` appears. Right-click it, choose **Rename**, and rename it to `enquiries-app`.
5. Click **+ Folder** and create a folder called `enquiries-data`. The app keeps its database here.
6. Delete the zip.

## 4. Create the Node.js app

**Software → Setup Node.js App → Create Application**, then fill in:

| Field | Value |
|---|---|
| Node.js version | the highest **22.x** (or newer) on the list. It must be **22.13 or newer** |
| Application mode | Production |
| Application root | `enquiries-app` |
| Application URL | choose `enquiries.raresquaredlabs.co.uk` and leave the path box empty |
| Application startup file | `app.js` |

Under **Environment variables**, click **Add Variable** for each:

| Name | Value |
|---|---|
| `ADMIN_PASSWORD` | from step 2 |
| `APP_SECRET` | from step 2 |
| `CRON_KEY` | from step 2 |
| `APP_URL` | `https://enquiries.raresquaredlabs.co.uk` |
| `DATA_DIR` | `/home/d3wl4ur63d24/enquiries-data` |
| `DISABLE_POLLER` | `1` |
| `NODE_NO_WARNINGS` | `1` |

Click **Create**. When the page reloads, scroll down and click **Run NPM Install**. Wait for it to finish, then click **Restart** at the top.

Open **https://enquiries.raresquaredlabs.co.uk/admin**. You should see the sign-in page ✓

## 5. The wake-up cron job

**Advanced → Cron Jobs**:
- **Common settings:** "Once Per Five Minutes (*/5 * * * *)"
- **Command:** (put your CRON_KEY at the end)
  ```
  curl -fsS https://enquiries.raresquaredlabs.co.uk/api/cron/YOUR_CRON_KEY > /dev/null
  ```
- Click **Add New Cron Job**.

To check it: open `https://enquiries.raresquaredlabs.co.uk/api/cron/YOUR_CRON_KEY` in your browser. It should show `{"ok":true,...}`.

## 6. Set up and test sending

1. Log in to `/admin`, click **✨ Set up AI** and paste your API key.
2. Create a business, go to **1. Enquiries mailbox**, and connect a mailbox.
3. Look at the steps it lists:
   - **"Signed in to send mail"** ✓ means everything works.
   - **"Could not confirm sending"** means this hosting blocks the app from sending email through other providers' mail servers. Receiving, AI drafts and the dashboard still work, and drafts can be sent with the "Open in email app" button. To fix it properly, ask 123-reg support to *"allow outbound SMTP connections on ports 465 and 587 for my cPanel account"*. Mailboxes hosted in this same cPanel account usually send fine.

---

## Updating to a new version

1. Download the zip again (step 3.1), upload it to your home folder and extract it.
2. Delete the old `enquiries-app` folder and rename the newly extracted folder to `enquiries-app`. Your data is safe: it lives in `enquiries-data`, not in `enquiries-app`.
3. In **Setup Node.js App**, click the app's edit (pencil) icon, then **Run NPM Install**, then **Restart**.

Your settings and environment variables stay in Setup Node.js App, and your data stays in `enquiries-data`.

## Backups

Download `enquiries-data` from File Manager now and then (right-click → **Compress**, then download the zip). Your host's backups may already include your whole home folder.

## Troubleshooting

| Problem | Check |
|---|---|
| Error page at the subdomain | Setup Node.js App → open the app → **Restart**. Errors are written to `enquiries-app/stderr.log` (File Manager). |
| "This app needs Node.js 22.13 or newer" in the log | Edit the app and choose a newer Node.js version, then Restart. If none is offered, ask 123-reg to enable Node.js 22.13+ |
| Wake-up link shows "Not found" | `CRON_KEY` must match exactly and be at least 16 characters. Restart the app after changing variables |
| New emails arrive late | They're checked when the cron job runs (every 5 minutes) |
| Can't connect a mailbox at all | For Gmail, use an app password. If no provider works, the hosting may block outgoing port 993. Ask 123-reg to allow it |
