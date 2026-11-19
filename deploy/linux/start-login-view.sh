#!/bin/sh
set -eu
umask 077
mkdir -p /run/df-view
rm -f /run/df-view/login.sock /run/df-view/view.sock
export NO_AT_BRIDGE=0
dbus-update-activation-environment DISPLAY XAUTHORITY XDG_RUNTIME_DIR
/usr/bin/python3 /app/login_view.py &
x11vnc -norc -display "$DISPLAY" -localhost -no6 -rfbport 5901 -forever -shared -nopw -nosel -noxdamage -quiet &
socat UNIX-LISTEN:/run/df-view/view.sock,fork,mode=0600 TCP4:127.0.0.1:5901 &
wait
