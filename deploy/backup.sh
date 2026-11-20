#!/bin/sh
# Cadangan database harian. Dijalankan dari cron (lihat DEPLOY.md):
#   0 2 * * * /opt/catatkeuangan/deploy/backup.sh >> /var/log/catatkeuangan-backup.log 2>&1
# Hasil: file .dump (format kustom pg_dump), dipulihkan dengan pg_restore. Yang lebih dari 14 hari dihapus.
set -eu
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/var/backups/catatkeuangan}"
mkdir -p "$DEST"
chmod 700 "$DEST"   # isinya data keuangan: hanya pemilik yang boleh membaca
FILE="$DEST/catatkeuangan-$(date +%F-%H%M).dump"
umask 077
if ! docker compose exec -T db pg_dump -U catatkeuangan -Fc catatkeuangan > "$FILE"; then
  rm -f "$FILE"; echo "GAGAL: pg_dump"; exit 1
fi
[ -s "$FILE" ] || { rm -f "$FILE"; echo "GAGAL: file cadangan kosong"; exit 1; }
find "$DEST" -name 'catatkeuangan-*.dump' -mtime +14 -delete
echo "OK $(date -Is) $FILE ($(du -h "$FILE" | cut -f1))"
