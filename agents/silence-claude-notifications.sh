#!/bin/bash
# Отключает звук уведомлений от Claude на Mac
set -euo pipefail

PLIST="$HOME/Library/Preferences/com.apple.ncprefs.plist"

# Найти bundle ID Claude
BUNDLE_ID=$(osascript -e 'id of app "Claude"' 2>/dev/null || true)

if [[ -z "$BUNDLE_ID" ]]; then
  # Попробовать найти вручную
  APP_PATH=$(find /Applications "$HOME/Applications" -name "Claude.app" -maxdepth 3 2>/dev/null | head -1)
  if [[ -n "$APP_PATH" ]]; then
    BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)
  fi
fi

if [[ -z "$BUNDLE_ID" ]]; then
  echo "❌ Не удалось найти Claude.app. Убедитесь, что Claude установлен в /Applications."
  exit 1
fi

echo "✅ Bundle ID: $BUNDLE_ID"

# Python-скрипт для изменения флагов уведомлений
python3 - "$PLIST" "$BUNDLE_ID" <<'PY'
import sys
import plistlib
import subprocess
from pathlib import Path

plist_path = Path(sys.argv[1])
bundle_id  = sys.argv[2]

# Конвертировать в XML для удобного редактирования
subprocess.run(["plutil", "-convert", "xml1", str(plist_path)], check=True)

with open(plist_path, "rb") as f:
    data = plistlib.load(f)

apps = data.get("apps", [])
found = False

for app in apps:
    if app.get("bundle-id") == bundle_id:
        flags = app.get("flags", 0)
        # Бит 4 (0x10 = 16) — звук. Сбрасываем его.
        if flags & 16:
            app["flags"] = flags & ~16
            print(f"🔇 Звук отключён (flags: {flags} → {app['flags']})")
        else:
            print("ℹ️  Звук уже был отключён.")
        found = True
        break

if not found:
    print(f"⚠️  Приложение '{bundle_id}' не найдено в настройках уведомлений.")
    print("    Откройте Claude хотя бы раз и повторите.")
    sys.exit(1)

with open(plist_path, "wb") as f:
    plistlib.dump(data, f)

# Обратно в бинарный формат
subprocess.run(["plutil", "-convert", "binary1", str(plist_path)], check=True)

print("✅ Настройки сохранены.")
PY

# Перезапустить Notification Center
echo "🔄 Перезапускаю Notification Center..."
killall "NotificationCenter" 2>/dev/null || true

echo "🎉 Готово! Уведомления от Claude теперь беззвучные."
