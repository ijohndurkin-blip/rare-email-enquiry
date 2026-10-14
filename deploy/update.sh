#!/usr/bin/env bash
# Pull the latest code and restart. Run on the server: sudo /opt/enquiries/deploy/update.sh
set -euo pipefail
cd /opt/enquiries
sudo -u enquiries git pull --ff-only
sudo -u enquiries npm ci --omit=dev
systemctl restart enquiries
sleep 2
systemctl --no-pager --lines=5 status enquiries
