#!/bin/sh
set -eu

mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config" "$HOME/.local/share" "$QQ_BRIDGE_DATA_DIR"
chmod 700 "$XDG_RUNTIME_DIR" "$QQ_BRIDGE_DATA_DIR"

# An interrupted Xvfb can leave these two sockets behind in this container.
node -e 'const fs=require("node:fs"); for (const p of ["/tmp/.X99-lock","/tmp/.X11-unix/X99"]) { try { fs.unlinkSync(p) } catch (e) { if (e.code !== "ENOENT") throw e } }'
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/duskfox-xvfb.log 2>&1 &
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [ -S /tmp/.X11-unix/X99 ]; then break; fi
  sleep 1
done
[ -S /tmp/.X11-unix/X99 ] || { echo 'Xvfb did not start' >&2; exit 1; }

eval "$(dbus-launch --sh-syntax)"
fluxbox >/tmp/duskfox-fluxbox.log 2>&1 &
exec qq --no-sandbox --disable-gpu --disable-software-rasterizer --disable-gpu-compositing
