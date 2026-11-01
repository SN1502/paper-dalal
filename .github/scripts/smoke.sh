#!/usr/bin/env bash
# Installs the APK on the emulator, opens it and a few screens, and records whether the app
# stays alive, with screenshots and the device log in ./smoke.
set -u
PKG=com.paperdalal.app
OUT=smoke
mkdir -p "$OUT"
APK=$(ls PaperDalal-*.apk | head -1)
echo "Testing $APK"

alive() { adb shell pidof "$PKG" > /dev/null 2>&1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true; }

adb wait-for-device
if ! adb install -r -g "$APK" > "$OUT/install.txt" 2>&1; then
  echo install-failed > "$OUT/status"
  cat "$OUT/install.txt"
  exit 0
fi
adb logcat -c

status=alive
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 40
shot 1-launch
alive || status=crashed-on-launch

if [ "$status" = alive ]; then
  # The strategy scan downloads two years of prices for ~130 stocks.
  adb shell am start -a android.intent.action.VIEW -d "paperdalal://ai/signals" "$PKG" > /dev/null 2>&1
  sleep 75
  shot 2-signals
  alive || status=crashed-on-signals
fi
if [ "$status" = alive ]; then
  adb shell am start -a android.intent.action.VIEW -d "paperdalal://ai" "$PKG" > /dev/null 2>&1
  sleep 12
  shot 3-ai
  adb shell am start -a android.intent.action.VIEW -d "paperdalal://stock/RELIANCE.NS" "$PKG" > /dev/null 2>&1
  sleep 25
  shot 4-stock
  alive || status=crashed-on-stock
fi
if [ "$status" = alive ]; then
  adb shell am start -a android.intent.action.VIEW -d "paperdalal://portfolio" "$PKG" > /dev/null 2>&1
  sleep 8
  shot 5-portfolio
  alive || status=crashed-on-portfolio
fi

echo "$status" > "$OUT/status"
adb logcat -d -v time > "$OUT/logcat.txt" 2>/dev/null || true
grep -E "AndroidRuntime|ReactNativeJS|ReactNative|FATAL|PaperDalal|Expo|DEBUG   |libc   " "$OUT/logcat.txt" | tail -800 > "$OUT/logcat-app.txt" || true
echo "Smoke test result: $status"
